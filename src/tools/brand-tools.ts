import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";
import { brandDashboardUrl } from "../links.js";
import { etaFor } from "../etas.js";

/**
 * Brand Tools — a "tool page" is a form PostKing renders at
 * `{brand domain}/tools/{slug}`: a visitor fills it in, PostKing forwards the
 * answers to the client's own backend (or skips the forward entirely for
 * kind "none" — a pure lead-capture tool with no backend), renders a small
 * `{{placeholder}}` HTML template against the response, and hands the
 * visitor off to a continue/redirect URL. See
 * docs/122-tool-pages/00-reqs.md ("Creating from MCP") and
 * docs/122-tool-pages/01-imp-prompt.md (PHASE 4) in the PostKing repo.
 *
 * Every tool here proxies `/api/agent/v1/brands/{brandId}/tools*`
 * (`PostKing/lib/agent/schemas/brand-tools.ts` is the source of truth for
 * every field shape below — keep this file's params in sync with it).
 *
 * Canonical flow: `tool_generate` (description → draft, poll `get_job`) OR
 * `tool_create` (hand-write the full spec) → `tool_update` (set
 * resultTemplate/handoffUrl/handoffMode/emailGate/usageLimitPerDay) →
 * `tool_preview` (repeat until `missingKeys` is empty) → `tool_publish` →
 * `tool_runs` / `tool_leads` to check on it.
 *
 * `apiKey` is write-only everywhere: it is sent to the client's own
 * endpointUrl as `Authorization: Bearer {apiKey}` but NEVER echoed back by
 * any read — `tool_list`/`tool_get`/`tool_create`/`tool_update`/
 * `tool_publish` responses carry `apiKeyLast4` (last 4 characters, or null)
 * instead. There is no way to read a stored apiKey back through this API.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const TOOL_INPUT_TYPES = ["text", "number", "email", "url", "select", "textarea"] as const;
const RESULT_TYPES = ["json", "text", "url"] as const;
const HANDOFF_MODES = ["result", "redirect"] as const;
const EMAIL_GATES = ["none", "before", "after"] as const;

/** Mirrors `ToolInputField` (PostKing `types/tools.ts`) — one `inputSchema` entry. */
const ToolInputFieldSchema = z.object({
  key: z.string().describe("Form field name — also the key inputs are submitted under and read via {{input.<key>}} in templates."),
  label: z.string().describe("Visible field label."),
  type: z.enum(TOOL_INPUT_TYPES).describe("Input type: text, number, email, url, select, or textarea."),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional().describe("Choices for type 'select'."),
});

// ── Descriptions shared between tool_create and tool_update ────────────────

const ENDPOINT_URL_DESC =
  "The client's own backend URL PostKing POSTs (or GETs, per endpointMethod) form submissions to, as " +
  '{ toolSlug, runId, inputs, visitor }, header "Authorization: Bearer {apiKey}". Omit or pass null for kind ' +
  '"none" — a pure lead-capture tool with no backend call; execute then skips the forward and the result is ' +
  "just the visitor's own inputs echoed back through resultTemplate/handoffUrl.";

const API_KEY_DESC =
  "Write-only. Sent as the endpointUrl's Authorization: Bearer token; never echoed back by any tool_* response " +
  "— those expose apiKeyLast4 (last 4 characters, or null) instead.";

const RESULT_TEMPLATE_DESC =
  "Mustache-style HTML rendered against the client endpoint's JSON response and the visitor's own submitted " +
  "inputs. Placeholders: {{path.to.value}} (dotted path into the response JSON) and {{input.<key>}} (a " +
  'submitted form value, e.g. {{input.email}}). No loops or conditionals — {{#if}}/{{#each}} are left as ' +
  'literal text. A missing value renders as "" (never the literal placeholder). Sanitized server-side on write ' +
  "(script tags, inline handlers, and iframes are stripped/rejected) — placeholders survive sanitization " +
  "intact. When null, the renderer falls back to legacy resultType (json/text/url) rendering. Publish only " +
  "after tool_preview shows an empty missingKeys array.";

const HANDOFF_URL_DESC =
  "Where the visitor is sent after (or instead of) the result. Same {{path.to.value}} / {{input.<key>}} " +
  'placeholder syntax as resultTemplate, URL-encoded — e.g. "https://client.com/signup?score={{score}}&email=' +
  '{{input.email}}". The client endpoint\'s own JSON response may include a top-level "redirectUrl" field, ' +
  "which overrides this at render time.";

const HANDOFF_MODE_DESC =
  '"result": show the rendered resultTemplate with a Continue button pointing at the filled handoffUrl ' +
  '(hidden when handoffUrl is null). "redirect": skip the result screen and redirect immediately once the ' +
  "response (or, for async tools, the poll) resolves.";

const EMAIL_GATE_DESC =
  '"none": no gate. "before": execute rejects a submission with no email-type input value. "after": execute ' +
  "computes and stores the result but withholds it, returning { gated: true, runId } until a second execute " +
  "call supplies { runId, email }.";

// ── Projectors ───────────────────────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => r != null && typeof r === "object") : [];
}

const toolProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, name: r.name, slug: r.slug, isPublished: r.isPublished, isFree: r.isFree }),
  medium: (r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    isPublished: r.isPublished,
    isFree: r.isFree,
    kind: r.endpointUrl ? "proxy" : "none",
    endpointMethod: r.endpointMethod,
    resultType: r.resultType,
    hasResultTemplate: r.resultTemplate != null,
    handoffMode: r.handoffMode,
    emailGate: r.emailGate,
    usageLimitPerDay: r.usageLimitPerDay ?? null,
    usageCount: r.usageCount,
    apiKeyLast4: r.apiKeyLast4 ?? null,
    description: truncate(r.description, 160),
    webUrl: r.webUrl ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }),
};

const runProj: Projector<Record<string, unknown>> = {
  short: (r) => {
    const run = asObj(r.run);
    return { id: r.id, createdAt: r.createdAt, runStatus: run.status ?? null };
  },
  medium: (r) => {
    const run = asObj(r.run);
    return {
      id: r.id,
      createdAt: r.createdAt,
      ip: r.ip,
      cookieId: r.cookieId,
      runStatus: run.status ?? null,
      runError: run.error ?? null,
      hasResult: r.result != null || run.result != null,
    };
  },
};

const leadProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, email: r.email, createdAt: r.createdAt }),
  medium: (r) => ({
    id: r.id,
    email: r.email,
    source: r.source,
    createdAt: r.createdAt,
    lastToolRunId: r.lastToolRunId ?? null,
    lastToolInputs: r.lastToolInputs ?? null,
  }),
};

// ── Tool registration ───────────────────────────────────────────────────────

export function registerBrandToolsTools(server: McpServer) {
  // ── tool_list ─────────────────────────────────────────────────────────
  server.tool(
    "tool_list",
    [
      "List the brand's tool pages (forms at /tools/{slug} on the brand's domain that forward to the client's own backend, or capture leads with no backend at all).",
      "short {id,name,slug,isPublished,isFree}; medium adds kind (proxy|none), endpointMethod, resultType, handoffMode, emailGate, usageLimitPerDay, usageCount, apiKeyLast4, description, webUrl, timestamps; full = raw (still never includes apiKey — see module notes).",
      `limit (default 10, max 50) caps the returned rows; apiKey is write-only, never returned — see tool_get.`,
    ].join(" "),
    {
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max rows to return (default 10, max 50)."),
      cursor: z.string().optional().describe("Reserved for forward-compatible pagination — the brand tools list has no pagination today."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ limit, cursor, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (cursor) qs.set("cursor", cursor);
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/tools${suffix}`);
      const rows = asRows(data);
      const sliced = rows.slice(0, limit);
      const truncated = sliced.length < rows.length;

      const result: Record<string, unknown> = {
        tools: projectList(detail, sliced, toolProj),
        count: sliced.length,
        total: rows.length,
        truncated,
        detail,
        dashboardUrl: brandDashboardUrl(id, "tools"),
      };
      if (truncated) {
        result.note = `Showing ${sliced.length} of ${rows.length} tools. Raise \`limit\` (max 50) to see more.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── tool_get ──────────────────────────────────────────────────────────
  server.tool(
    "tool_get",
    [
      "Fetch a single tool page by ID.",
      "short {id,name,slug,isPublished,isFree}; medium adds kind, endpointMethod, resultType, handoffMode, emailGate, usageLimitPerDay, usageCount, apiKeyLast4, description, webUrl, timestamps; full = raw (inputSchema, resultTemplate, handoffUrl, all copy fields — still never apiKey itself, only apiKeyLast4).",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID."),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ toolId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}`);
      const row = asObj(data);
      return { content: [{ type: "text" as const, text: JSON.stringify(project(detail, row, toolProj)) }] };
    }
  );

  // ── tool_create ───────────────────────────────────────────────────────
  server.tool(
    "tool_create",
    [
      "Create a tool page (a form at /tools/{slug} on the brand's domain) with the full spec in one call.",
      `endpointUrl: ${ENDPOINT_URL_DESC}`,
      `apiKey: ${API_KEY_DESC}`,
      `resultTemplate: ${RESULT_TEMPLATE_DESC}`,
      `handoffMode: ${HANDOFF_MODE_DESC}`,
      `handoffUrl: ${HANDOFF_URL_DESC}`,
      `emailGate: ${EMAIL_GATE_DESC}`,
      "A freshly created tool always starts unpublished — call tool_preview until missingKeys is empty, then tool_publish.",
    ].join(" "),
    {
      name: z.string().min(1).describe("Tool name."),
      slug: z.string().min(1).describe("URL slug — the tool renders at /tools/{slug} on the brand's domain."),
      description: z.string().nullable().optional(),
      endpointUrl: z.string().nullable().optional().describe(ENDPOINT_URL_DESC),
      endpointMethod: z
        .enum(["GET", "POST"])
        .optional()
        .describe("How the visitor's inputs reach endpointUrl. POST (default): a JSON body. GET: appended as a query string."),
      apiKey: z.string().nullable().optional().describe(API_KEY_DESC),
      isAsync: z.boolean().optional().describe("True when endpointUrl responds 202 and calls back later (ToolRun polling)."),
      inputSchema: z.array(ToolInputFieldSchema).optional().describe("The form fields the visitor fills in."),
      isFree: z.boolean().optional(),
      resultType: z.enum(RESULT_TYPES).optional().describe("Fallback rendering (json/text/url) used only when resultTemplate is null."),
      conversionCopy: z.string().nullable().optional(),
      ctaHeadline: z.string().nullable().optional(),
      benefitBullets: z.array(z.string()).optional(),
      usageLabel: z.string().nullable().optional(),
      showUsageCount: z.boolean().optional(),
      emailGate: z.enum(EMAIL_GATES).optional().describe(EMAIL_GATE_DESC),
      sampleOutput: z.string().nullable().optional().describe("Free-text sample of what the client endpoint returns — used as the default sampleResponse for tool_preview when omitted there."),
      usageLimitPerDay: z.number().int().positive().nullable().optional().describe("Caps executions per visitor (guest token or IP) per UTC day. null (default): no limit. Over limit -> 429 LIMIT_REACHED."),
      showTestimonials: z.boolean().optional(),
      resultTemplate: z.string().nullable().optional().describe(RESULT_TEMPLATE_DESC),
      handoffMode: z.enum(HANDOFF_MODES).optional().describe(HANDOFF_MODE_DESC),
      handoffUrl: z.string().nullable().optional().describe(HANDOFF_URL_DESC),
      brandId: brandOpt,
    },
    async ({
      name,
      slug,
      description,
      endpointUrl,
      endpointMethod,
      apiKey,
      isAsync,
      inputSchema,
      isFree,
      resultType,
      conversionCopy,
      ctaHeadline,
      benefitBullets,
      usageLabel,
      showUsageCount,
      emailGate,
      sampleOutput,
      usageLimitPerDay,
      showTestimonials,
      resultTemplate,
      handoffMode,
      handoffUrl,
      brandId,
    }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { name, slug };
      if (description !== undefined) body.description = description;
      if (endpointUrl !== undefined) body.endpointUrl = endpointUrl;
      if (endpointMethod !== undefined) body.endpointMethod = endpointMethod;
      if (apiKey !== undefined) body.apiKey = apiKey;
      if (isAsync !== undefined) body.isAsync = isAsync;
      if (inputSchema !== undefined) body.inputSchema = inputSchema;
      if (isFree !== undefined) body.isFree = isFree;
      if (resultType !== undefined) body.resultType = resultType;
      if (conversionCopy !== undefined) body.conversionCopy = conversionCopy;
      if (ctaHeadline !== undefined) body.ctaHeadline = ctaHeadline;
      if (benefitBullets !== undefined) body.benefitBullets = benefitBullets;
      if (usageLabel !== undefined) body.usageLabel = usageLabel;
      if (showUsageCount !== undefined) body.showUsageCount = showUsageCount;
      if (emailGate !== undefined) body.emailGate = emailGate;
      if (sampleOutput !== undefined) body.sampleOutput = sampleOutput;
      if (usageLimitPerDay !== undefined) body.usageLimitPerDay = usageLimitPerDay;
      if (showTestimonials !== undefined) body.showTestimonials = showTestimonials;
      if (resultTemplate !== undefined) body.resultTemplate = resultTemplate;
      if (handoffMode !== undefined) body.handoffMode = handoffMode;
      if (handoffUrl !== undefined) body.handoffUrl = handoffUrl;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/tools`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── tool_generate ─────────────────────────────────────────────────────
  server.tool(
    "tool_generate",
    (() => {
      const eta = etaFor("brand_tool_generate");
      return [
        "Async. AI-drafts a tool page (name, slug, inputSchema, marketing copy) from a plain-language description of what the client's endpoint does.",
        "Returns { operationId, status } — poll get_job until state=completed; the completed result carries { toolId, slug }.",
        "The draft also proposes resultTemplate/handoffUrl — best results when pastedSampleOutput is supplied. Refine with tool_update, iterate with tool_preview until missingKeys is empty, then tool_publish.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      description: z.string().min(1).describe("Plain-language description of what this tool does for the visitor."),
      endpointUrl: z.string().nullable().optional().describe("The client's backend URL this tool will call. Omit or pass null for kind \"none\" — a pure lead-capture tool with no backend call."),
      endpointMethod: z.enum(["GET", "POST"]).optional(),
      apiKey: z.string().nullable().optional().describe(API_KEY_DESC),
      inputsOutputs: z.string().min(1).describe("Plain-language description of what the form should collect and what the endpoint returns."),
      pastedSampleOutput: z.string().nullable().optional().describe("A sample JSON response from the client's own API. When supplied, the draft also proposes a resultTemplate and handoffUrl from it; stored on the tool as sampleOutput."),
      brandId: brandOpt,
    },
    async ({ description, endpointUrl, endpointMethod, apiKey, inputsOutputs, pastedSampleOutput, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { description, inputsOutputs };
      if (endpointUrl !== undefined) body.endpointUrl = endpointUrl;
      if (endpointMethod !== undefined) body.endpointMethod = endpointMethod;
      if (apiKey !== undefined) body.apiKey = apiKey;
      if (pastedSampleOutput !== undefined) body.pastedSampleOutput = pastedSampleOutput;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/tools/generate`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── tool_update ───────────────────────────────────────────────────────
  server.tool(
    "tool_update",
    [
      "Partial update of a tool page — only supplied fields change.",
      `endpointUrl: ${ENDPOINT_URL_DESC}`,
      `apiKey: ${API_KEY_DESC}`,
      `resultTemplate: ${RESULT_TEMPLATE_DESC}`,
      `handoffMode: ${HANDOFF_MODE_DESC}`,
      `handoffUrl: ${HANDOFF_URL_DESC}`,
      `emailGate: ${EMAIL_GATE_DESC}`,
      "isPublished is accepted here but prefer tool_publish — it fires the same publish hooks (llms.txt, IndexNow, link graph) without resending the whole tool body.",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID to update."),
      name: z.string().min(1).optional(),
      slug: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      endpointUrl: z.string().nullable().optional().describe(ENDPOINT_URL_DESC),
      endpointMethod: z.enum(["GET", "POST"]).optional(),
      apiKey: z.string().nullable().optional().describe(API_KEY_DESC),
      isAsync: z.boolean().optional(),
      inputSchema: z.array(ToolInputFieldSchema).optional(),
      isPublished: z.boolean().optional().describe("Prefer tool_publish for this — see the tool description."),
      isFree: z.boolean().optional(),
      resultType: z.enum(RESULT_TYPES).optional(),
      conversionCopy: z.string().nullable().optional(),
      ctaHeadline: z.string().nullable().optional(),
      benefitBullets: z.array(z.string()).optional(),
      usageLabel: z.string().nullable().optional(),
      showUsageCount: z.boolean().optional(),
      emailGate: z.enum(EMAIL_GATES).optional().describe(EMAIL_GATE_DESC),
      sampleOutput: z.string().nullable().optional(),
      usageLimitPerDay: z.number().int().positive().nullable().optional(),
      showTestimonials: z.boolean().optional(),
      resultTemplate: z.string().nullable().optional().describe(RESULT_TEMPLATE_DESC),
      handoffMode: z.enum(HANDOFF_MODES).optional().describe(HANDOFF_MODE_DESC),
      handoffUrl: z.string().nullable().optional().describe(HANDOFF_URL_DESC),
      brandId: brandOpt,
    },
    async ({
      toolId,
      name,
      slug,
      description,
      endpointUrl,
      endpointMethod,
      apiKey,
      isAsync,
      inputSchema,
      isPublished,
      isFree,
      resultType,
      conversionCopy,
      ctaHeadline,
      benefitBullets,
      usageLabel,
      showUsageCount,
      emailGate,
      sampleOutput,
      usageLimitPerDay,
      showTestimonials,
      resultTemplate,
      handoffMode,
      handoffUrl,
      brandId,
    }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (slug !== undefined) body.slug = slug;
      if (description !== undefined) body.description = description;
      if (endpointUrl !== undefined) body.endpointUrl = endpointUrl;
      if (endpointMethod !== undefined) body.endpointMethod = endpointMethod;
      if (apiKey !== undefined) body.apiKey = apiKey;
      if (isAsync !== undefined) body.isAsync = isAsync;
      if (inputSchema !== undefined) body.inputSchema = inputSchema;
      if (isPublished !== undefined) body.isPublished = isPublished;
      if (isFree !== undefined) body.isFree = isFree;
      if (resultType !== undefined) body.resultType = resultType;
      if (conversionCopy !== undefined) body.conversionCopy = conversionCopy;
      if (ctaHeadline !== undefined) body.ctaHeadline = ctaHeadline;
      if (benefitBullets !== undefined) body.benefitBullets = benefitBullets;
      if (usageLabel !== undefined) body.usageLabel = usageLabel;
      if (showUsageCount !== undefined) body.showUsageCount = showUsageCount;
      if (emailGate !== undefined) body.emailGate = emailGate;
      if (sampleOutput !== undefined) body.sampleOutput = sampleOutput;
      if (usageLimitPerDay !== undefined) body.usageLimitPerDay = usageLimitPerDay;
      if (showTestimonials !== undefined) body.showTestimonials = showTestimonials;
      if (resultTemplate !== undefined) body.resultTemplate = resultTemplate;
      if (handoffMode !== undefined) body.handoffMode = handoffMode;
      if (handoffUrl !== undefined) body.handoffUrl = handoffUrl;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── tool_publish ──────────────────────────────────────────────────────
  server.tool(
    "tool_publish",
    [
      "Flip a tool page's published state.",
      "Publishing (false -> true) fires background hooks once: AI conversion-copy backfill (if unset), llms.txt, IndexNow submission, and the SEO link graph.",
      "Publish only after tool_preview shows an empty missingKeys array — a template referencing a field the client's response never returns will render blank for every visitor.",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID to publish or unpublish."),
      isPublished: z.boolean().describe("true to publish, false to unpublish."),
      brandId: brandOpt,
    },
    async ({ toolId, isPublished, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}/publish`, { isPublished });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── tool_delete ───────────────────────────────────────────────────────
  server.tool(
    "tool_delete",
    ["Permanently delete a tool page."].join(" "),
    {
      toolId: z.string().describe("Tool ID to delete."),
      brandId: brandOpt,
    },
    async ({ toolId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── tool_preview ──────────────────────────────────────────────────────
  server.tool(
    "tool_preview",
    [
      "Render a tool's stored resultTemplate/handoffUrl against sample data — the same renderer execute uses on a real submission — without calling the client's endpoint.",
      "Falls back to the tool's stored sampleOutput (parsed as JSON when it parses) when sampleResponse is omitted.",
      "Check missingKeys is empty before calling tool_publish — a non-empty list means the template references a field the sample (or the client's real response) doesn't have, which will render blank for every real visitor.",
      "The returned html is truncated to 4000 characters (htmlTruncated flags this) — the full rendered page is what visitors see live; this is for spot-checking the template.",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID to preview."),
      sampleResponse: z.unknown().optional().describe("A sample of the client endpoint's JSON response, used to render resultTemplate/handoffUrl. Falls back to the tool's stored sampleOutput when omitted."),
      sampleInputs: z.record(z.string(), z.unknown()).optional().describe("Sample visitor form values, for {{input.<key>}} placeholders. Defaults to {}."),
      brandId: brandOpt,
    },
    async ({ toolId, sampleResponse, sampleInputs, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (sampleResponse !== undefined) body.sampleResponse = sampleResponse;
      if (sampleInputs !== undefined) body.sampleInputs = sampleInputs;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}/preview`, body);
      const raw = asObj(data);
      const html = typeof raw.html === "string" ? raw.html : "";
      const htmlTruncated = html.length > 4000;
      const missingKeys = Array.isArray(raw.missingKeys) ? raw.missingKeys : [];

      const result: Record<string, unknown> = {
        html: htmlTruncated ? html.slice(0, 4000) : html,
        htmlTruncated,
        handoffUrl: raw.handoffUrl ?? null,
        missingKeys,
      };
      if (missingKeys.length > 0) {
        result.note = `${missingKeys.length} placeholder(s) had no value in this sample: ${missingKeys.join(", ")}. Do not tool_publish until this is empty.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── tool_runs ─────────────────────────────────────────────────────────
  server.tool(
    "tool_runs",
    [
      "Execution history for a tool page — one row per visitor submission (sync or async), newest first, joined against the async ToolRun result when present.",
      "short {id,createdAt,runStatus}; medium adds ip, cookieId, runError, hasResult; full = raw.",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID."),
      page: z.number().int().positive().optional().default(1).describe("Defaults to 1."),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max rows per page (default 10, max 50)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ toolId, page, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("limit", String(limit));
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}/runs${suffix}`);
      const raw = asObj(data);
      const rows = asRows(raw.runs);
      const total = typeof raw.total === "number" ? raw.total : rows.length;
      const truncated = page * limit < total;

      const result: Record<string, unknown> = {
        runs: projectList(detail, rows, runProj),
        count: rows.length,
        total,
        truncated,
        page,
        limit,
        detail,
        dashboardUrl: brandDashboardUrl(id, "tools"),
      };
      if (truncated) {
        result.note = `Showing page ${page} of ${limit}-row pages (${total} total runs). Raise \`limit\` (max 50) or increment \`page\` to see more.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── tool_leads ────────────────────────────────────────────────────────
  server.tool(
    "tool_leads",
    [
      "Leads captured through a tool page's execute flow, newest first, cursor-paginated.",
      "short {id,email,createdAt}; medium adds source, lastToolRunId, lastToolInputs; full = raw (includes lastToolResult).",
    ].join(" "),
    {
      toolId: z.string().describe("Tool ID."),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max rows to return (default 10, max 50)."),
      cursor: z.string().optional().describe("A lead id from the previous call's nextCursor, to continue."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ toolId, limit, cursor, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (cursor) qs.set("cursor", cursor);
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/tools/${toolId}/leads${suffix}`);
      const raw = asObj(data);
      const rows = asRows(raw.leads);
      const nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : null;
      const truncated = nextCursor !== null;

      const result: Record<string, unknown> = {
        leads: projectList(detail, rows, leadProj),
        nextCursor,
        count: rows.length,
        total: rows.length,
        truncated,
        detail,
        dashboardUrl: brandDashboardUrl(id, "tools"),
      };
      if (truncated) {
        result.note = `More leads exist — pass cursor="${nextCursor}" to continue.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
