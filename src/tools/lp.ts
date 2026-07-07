/**
 * Landing pages + side pages tools.
 *
 * All tools wrap /api/agent/v1/landing-pages/* and /api/agent/v1/brands/{id}/landing-pages
 * as mapped in docs/43-agentic/08-update-mcp/00-reqs.md §3.1.
 *
 * Async ops (generate, side-page generate) return { operationId } — use get_job to poll them.
 * vibe-edit is the exception: it lives in a separate session store, not the generic
 * job/operation queue — poll it with get_vibe_edit_status, not get_job.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, pick, truncate } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

/** The 11 valid landing-page section-order keys. */
const SECTION_ORDER_KEYS = [
  "hero",
  "features",
  "pricing",
  "cta",
  "faq",
  "howItWorks",
  "showcase",
  "categoryExplorer",
  "replacesStack",
  "comparisonMatrix",
  "roiCalculator",
] as const;

/** Truncate string values to `n` chars; pass non-strings through unchanged. */
function truncateVal(v: unknown, n: number): unknown {
  return typeof v === "string" ? truncate(v, n) : v;
}

// ── Section helpers ──────────────────────────────────────────────────────────

function getSections(row: unknown): Record<string, unknown> | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  for (const key of ["sections", "content", "data"] as const) {
    const v = r[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

function sectionKeys(row: unknown): string[] {
  const secs = getSections(row);
  if (secs !== null) return Object.keys(secs);
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    return Object.keys(row as object);
  }
  return [];
}

function wordCount(s: unknown): number {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.trim() === "" ? 0 : str.trim().split(/\s+/).length;
}

function sectionWordCounts(row: unknown): Record<string, number> | { total: number } {
  const secs = getSections(row);
  if (secs !== null) {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(secs)) {
      counts[k] = wordCount(v);
    }
    return counts;
  }
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    const r = row as Record<string, unknown>;
    let total = 0;
    for (const v of Object.values(r)) {
      if (typeof v === "string") total += wordCount(v);
    }
    return { total };
  }
  return { total: 0 };
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface LpListItem {
  id?: string;
  slug?: string;
  name?: string;
  status?: string;
  updatedAt?: string;
  currentVersionId?: string | number;
  publishedVersionId?: string | number;
  webUrl?: string;
  [k: string]: unknown;
}

interface LpDetail {
  id?: string;
  slug?: string;
  name?: string;
  status?: string;
  updatedAt?: string;
  currentVersionId?: string | number;
  publishedVersionId?: string | number;
  webUrl?: string;
  data?: unknown;
  content?: unknown;
  sections?: unknown;
  [k: string]: unknown;
}

interface LpDraft {
  id?: string;
  slug?: string;
  name?: string;
  status?: string;
  versionData?: unknown;
  data?: unknown;
  content?: unknown;
  sections?: unknown;
  [k: string]: unknown;
}

interface LpVersionItem {
  id?: string | number;
  name?: string;
  createdAt?: string;
  editorId?: string;
  description?: string;
  [k: string]: unknown;
}

interface LpVersionDetail {
  id?: string | number;
  name?: string;
  createdAt?: string;
  description?: string;
  editorId?: string;
  data?: unknown;
  content?: unknown;
  sections?: unknown;
  [k: string]: unknown;
}

interface SidePageItem {
  id?: string;
  slug?: string;
  name?: string;
  type?: string;
  isPublished?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  overrides?: unknown;
  config?: unknown;
  slotMap?: unknown;
  siteMetadata?: unknown;
  [k: string]: unknown;
}

interface SidePageDetail {
  id?: string;
  slug?: string;
  name?: string;
  type?: string;
  isPublished?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  overrides?: unknown;
  config?: unknown;
  slotMap?: unknown;
  siteMetadata?: unknown;
  rendered?: string;
  renderLinks?: unknown;
  [k: string]: unknown;
}

interface VibeEditChange {
  index?: number;
  path?: string;
  before?: unknown;
  after?: unknown;
  [k: string]: unknown;
}

interface VibeEditStatus {
  status?: string;
  progress?: number | string;
  stale?: boolean;
  baseVersionId?: string | number;
  currentVersionId?: string | number;
  changesCount?: number;
  credits?: unknown;
  changes?: VibeEditChange[];
  editedData?: unknown;
  error?: string;
  result?: {
    changes?: VibeEditChange[];
    credits?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface ApplyVibeEditResult {
  success?: boolean;
  versionId?: string | number;
  applied?: number;
  skipped?: number;
  previousVersionId?: string | number;
  [k: string]: unknown;
}

export function registerLpTools(server: McpServer) {
  // ── List landing pages ────────────────────────────────────────────────────
  server.tool(
    "list_landing_pages",
    "Lists landing pages. Default detail='short' (id/slug/name/status). Use view_landing_page for full content.",
    { brandId: brandOpt, detail: detailParam("short") },
    async ({ brandId, detail }) => {
      const id = requireBrandId(brandId);
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/brands/${id}/landing-pages`
      );
      const pages: LpListItem[] = Array.isArray(raw["landingPages"])
        ? (raw["landingPages"] as LpListItem[])
        : Array.isArray(raw["pages"])
        ? (raw["pages"] as LpListItem[])
        : Array.isArray(raw)
        ? (raw as unknown as LpListItem[])
        : [];
      const proj = {
        short: (row: LpListItem) => pick(row, ["id", "slug", "name", "status"]),
        medium: (row: LpListItem) =>
          pick(row, ["id", "slug", "name", "status", "updatedAt", "currentVersionId", "publishedVersionId", "webUrl"]),
      };
      const text = JSON.stringify({ count: pages.length, detail, landingPages: projectList(detail, pages, proj) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Generate landing page (async) ─────────────────────────────────────────
  server.tool(
    "generate_landing_page",
    [
      "Create and AI-generate a new landing page for the brand.",
      "Step 1: Creates the LP record with the given slug.",
      "Step 2: Kicks off async AI content generation immediately.",
      "Returns { slug, operationId, pollUrl } — poll with get_job(operationId) until state is 'completed' (or 'failed'/'partially_failed'/'cancelled' on error).",
      "For targeted edits to an existing page, prefer vibe_edit_landing_page.",
    ].join(" "),
    {
      topic: z.string().describe("Topic or product this landing page should be about"),
      slug: z.string().optional().describe("URL slug (auto-derived from topic if omitted)"),
      voiceProfileId: z.string().optional().describe("Voice profile ID for writing style"),
      brandId: brandOpt,
    },
    async ({ topic, slug, voiceProfileId, brandId }) => {
      const id = requireBrandId(brandId);
      const pageSlug = slug ?? topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await api.post<Record<string, unknown>>(`/api/agent/v1/brands/${id}/landing-pages`, { slug: pageSlug, brandId: id, name: topic });
      const genData = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${pageSlug}/generate`, {
        instructions: topic,
        voiceProfileId,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ slug: pageSlug, ...genData }, null, 2) }] };
    }
  );

  // ── View landing page ─────────────────────────────────────────────────────
  server.tool(
    "view_landing_page",
    "Fetch a landing page by slug. detail='full' (default) returns full data JSONB; 'medium' returns summary + sectionKeys/sectionWordCounts; 'short' returns id/slug/name/status. Section bodies and rendered HTML appear only at full.",
    {
      slug: z.string().describe("Landing page slug"),
      detail: detailParam("full"),
    },
    async ({ slug, detail }) => {
      const raw = await api.get<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}`);
      const p = (raw["landingPage"] !== undefined ? raw["landingPage"] : raw) as LpDetail;
      const proj = {
        short: (row: LpDetail) => pick(row, ["id", "slug", "name", "status"]),
        medium: (row: LpDetail) => ({
          ...pick(row, ["id", "slug", "name", "status", "updatedAt", "currentVersionId", "publishedVersionId", "webUrl"]),
          sectionKeys: sectionKeys(row),
          sectionWordCounts: sectionWordCounts(row),
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Edit landing page (manual patch) ─────────────────────────────────────
  server.tool(
    "edit_landing_page",
    [
      "Update METADATA ONLY — title and/or instructions — of a landing page. Does NOT touch page content.",
      "For content changes, use set_landing_page_section (targeted field/section writes) or vibe_edit_landing_page (AI-powered edits).",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      title: z.string().optional().describe("New title"),
      instructions: z.string().optional().describe("Editor instructions stored for reference"),
    },
    async ({ slug, title, instructions }) => {
      const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}`, {
        title,
        instructions,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Regenerate landing page ───────────────────────────────────────────────
  server.tool(
    "regenerate_landing_page",
    [
      "Re-generate a landing page's content using AI. Optionally restrict to specific sections.",
      "Returns an operationId — poll with get_job to track progress.",
      "For targeted edits to an existing page, prefer vibe_edit_landing_page.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      voiceProfileId: z.string().optional().describe("Voice profile ID"),
      instructions: z.string().optional().describe("Extra guidance for the AI"),
      sections: z
        .array(z.string())
        .optional()
        .describe("Specific section keys to regenerate (omit to regenerate all)"),
    },
    async ({ slug, voiceProfileId, instructions, sections }) => {
      const body: Record<string, unknown> = {};
      if (voiceProfileId) body.voiceProfileId = voiceProfileId;
      if (instructions) body.instructions = instructions;
      if (sections?.length) body.sections = sections;
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/generate`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Vibe edit (AI edit) ───────────────────────────────────────────────────
  server.tool(
    "vibe_edit_landing_page",
    [
      "Use AI to propose an edit to a landing page based on natural-language instructions. This is step 1 of a propose → review → apply flow — it does NOT change anything by itself:",
      "1) Call this tool. Returns { operationId } — nothing is applied yet.",
      "2) Poll get_vibe_edit_status(slug, operationId) — NOT get_job — until status is 'completed'. Vibe-edit sessions live in a separate store from the generic job/operation queue, so get_job will not find them.",
      "3) Review the `changes` array returned by get_vibe_edit_status: field-level before/after entries, each with an `index` and a `path`.",
      "4) Call apply_vibe_edit with all=true (accept everything) or a subset via indices/paths.",
      "5) Call publish_landing_page to make the applied changes live.",
      "scope='full' edits the whole page; scope='section' restricts the edit to one section — sectionId is REQUIRED when scope='section'. Example section keys: hero, features, pricing, cta, faq, howItWorks, showcase, categoryExplorer, replacesStack, comparisonMatrix, roiCalculator.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      instructions: z
        .string()
        .describe("Natural-language edit instructions, e.g. 'Make the CTA more urgent'"),
      scope: z
        .enum(["full", "section"])
        .optional()
        .describe("'full' edits the whole page; 'section' restricts the edit to one section (sectionId required)"),
      sectionId: z
        .string()
        .optional()
        .describe(
          "REQUIRED when scope='section'. E.g. hero, features, pricing, cta, faq, howItWorks, showcase, categoryExplorer, replacesStack, comparisonMatrix, roiCalculator."
        ),
    },
    async ({ slug, instructions, scope, sectionId }) => {
      if (scope === "section" && !sectionId) {
        throw new Error("sectionId is required when scope='section'");
      }
      const body: Record<string, unknown> = { instructions };
      if (scope) body.scope = scope;
      if (sectionId) body.sectionId = sectionId;
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/ai-edit`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Get vibe edit status ──────────────────────────────────────────────────
  server.tool(
    "get_vibe_edit_status",
    [
      "Poll vibe (AI) edit session status. detail='medium' (default) is the REVIEW view: { status, progress, stale, baseVersionId, currentVersionId, changesCount, credits, changes, error }",
      "where each `changes` entry is { index, path, before, after } (before/after truncated to 200 chars) — use these `index`/`path` values to select a subset in apply_vibe_edit.",
      "'short' returns just { status, progress, error }. 'full' returns the raw payload including the untruncated editedData.",
      "`error` is populated when status is 'failed' and carries the failure reason — surface it to the user instead of just reporting 'failed'.",
      "When status is 'completed', call apply_vibe_edit next (this tool never applies anything).",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      operationId: z.string().describe("Operation ID from vibe_edit_landing_page"),
      detail: detailParam("medium"),
    },
    async ({ slug, operationId, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/ai-edit/status/${operationId}`
      );
      const p = raw as VibeEditStatus;
      const proj = {
        short: (row: VibeEditStatus) => pick(row, ["status", "progress", "error"]),
        medium: (row: VibeEditStatus) => ({
          ...pick(row, ["status", "progress", "stale", "baseVersionId", "currentVersionId", "changesCount", "error"]),
          credits: row.result?.credits,
          changes: Array.isArray(row.result?.changes)
            ? row.result.changes.map((c, i) => ({
                index: typeof c.index === "number" ? c.index : i,
                path: c.path,
                before: truncateVal(c.before, 200),
                after: truncateVal(c.after, 200),
              }))
            : [],
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Apply vibe edit ───────────────────────────────────────────────────────
  server.tool(
    "apply_vibe_edit",
    [
      "Applies a completed vibe edit (from vibe_edit_landing_page) to the DRAFT as ONE new version.",
      "Pass exactly one of: all=true (accept every change), indices (subset by their `index` from get_vibe_edit_status), or paths (subset by their `path`).",
      "This does NOT publish — call publish_landing_page next to go live. Can be undone via restore_lp_version using the returned previousVersionId.",
      "If the draft has moved on since the edit was proposed (stale session), this returns a structured { error: 'stale_session', ... } payload instead of applying — either re-run vibe_edit_landing_page against the current draft, or retry this call with force=true to layer the selected changes onto the current draft.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      operationId: z.string().describe("Operation ID from vibe_edit_landing_page"),
      all: z.boolean().optional().describe("Apply every proposed change"),
      indices: z.array(z.number().int()).optional().describe("Subset of change `index` values to apply"),
      paths: z.array(z.string()).optional().describe("Subset of change `path` values to apply"),
      force: z
        .boolean()
        .optional()
        .describe("Apply even if the draft has moved on since the edit was proposed (stale session)"),
      name: z.string().optional().describe("Name for the new version"),
      description: z.string().optional().describe("Description for the new version"),
    },
    async ({ slug, operationId, all, indices, paths, force, name, description }) => {
      const selectorFlags = [
        all === true,
        Array.isArray(indices) && indices.length > 0,
        Array.isArray(paths) && paths.length > 0,
      ];
      const selectors = selectorFlags.filter(Boolean).length;
      if (selectors !== 1) {
        throw new Error(
          "Pass exactly one of: all=true, a non-empty indices array, or a non-empty paths array. Empty arrays don't count as a selector."
        );
      }
      const body: Record<string, unknown> = {};
      if (all !== undefined) body.all = all;
      if (indices !== undefined) body.indices = indices;
      if (paths !== undefined) body.paths = paths;
      if (force !== undefined) body.force = force;
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      try {
        const data = await api.post<ApplyVibeEditResult>(
          `/api/agent/v1/landing-pages/${slug}/ai-edit/session/${operationId}/apply`,
          body
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.code === "STALE_SESSION") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "stale_session",
                  message:
                    (err.message || "The draft has moved on since this vibe edit was proposed.") +
                    " Re-run vibe_edit_landing_page against the current draft, or retry apply_vibe_edit with force=true to layer the selected changes onto the current draft.",
                  baseVersionId: err.details?.baseVersionId,
                  currentVersionId: err.details?.currentVersionId,
                }),
              },
            ],
          };
        }
        throw err;
      }
    }
  );

  // ── Set landing page section (structured manual edit) ─────────────────────
  server.tool(
    "set_landing_page_section",
    [
      "Set one field on a landing page section (dot-paths in `field` supported, e.g. 'plans.0.ctaUrl'), or replace a whole section with replaceSection=true.",
      "Pass the bare content-section key (e.g. 'hero', 'features', 'pricing') — the server maps it into the page's content tree. Top-level roots like slotMap, config, navigation, siteMetadata are also accepted as-is.",
      "Each call creates a new draft version — for many related changes across a page, prefer vibe_edit_landing_page instead.",
      "Example: section='hero', field='title', value='New headline'.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      section: z
        .string()
        .describe(
          "Bare section key. For content sections use e.g. hero, features, pricing, cta, faq — the server maps these into the page's content tree. Top-level roots like slotMap, config, navigation, siteMetadata are also accepted."
        ),
      field: z
        .string()
        .optional()
        .describe("Dot-path field within the section to set, e.g. 'title' or 'plans.0.ctaUrl'. Required unless replaceSection=true."),
      value: z.any().describe("New value for the field (or the whole section when replaceSection=true)"),
      replaceSection: z.boolean().optional().describe("Replace the entire section with `value` instead of setting one field"),
      name: z.string().optional().describe("Name for the new version"),
      description: z.string().optional().describe("Description for the new version"),
    },
    async ({ slug, section, field, value, replaceSection, name, description }) => {
      if (!replaceSection && field === undefined) {
        throw new Error("field is required unless replaceSection=true");
      }
      const body: Record<string, unknown> = replaceSection
        ? { replaceSection: true, section, value }
        : { section, field, value, nested: true };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/update`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set landing page section layout (order + visibility) ──────────────────
  server.tool(
    "set_lp_section_layout",
    [
      "Reorder and/or toggle visibility of a landing page's sections. Pass at least one of sectionOrder/sectionVisibility.",
      `Valid section-order keys (all 11): ${SECTION_ORDER_KEYS.join(", ")}.`,
      "sectionVisibility keys are the toggleable subset of the above.",
      "When both are given, order is attempted first, then visibility — each is applied independently, so one can succeed while the other fails.",
      "The result always reports both outcomes: { order: <result>|{error}, visibility: <result>|{error}, partialFailure: true } if only one part failed.",
      "This tool only throws if every requested part fails (or if a single requested part fails).",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      sectionOrder: z
        .array(z.enum(SECTION_ORDER_KEYS))
        .optional()
        .describe("Full ordered list of section keys"),
      sectionVisibility: z
        .record(z.boolean())
        .optional()
        .describe("Map of section key → visible (true/false) for the toggleable sections"),
    },
    async ({ slug, sectionOrder, sectionVisibility }) => {
      if (sectionOrder === undefined && sectionVisibility === undefined) {
        throw new Error("Pass at least one of sectionOrder or sectionVisibility.");
      }

      const requested = (sectionOrder !== undefined ? 1 : 0) + (sectionVisibility !== undefined ? 1 : 0);

      let orderResult: unknown;
      let orderError: string | undefined;
      if (sectionOrder !== undefined) {
        try {
          orderResult = await api.patch<Record<string, unknown>>(
            `/api/agent/v1/landing-pages/${slug}/section-order`,
            { sectionOrder }
          );
        } catch (err) {
          orderError = err instanceof Error ? err.message : String(err);
          if (requested === 1) throw err;
        }
      }

      let visibilityResult: unknown;
      let visibilityError: string | undefined;
      if (sectionVisibility !== undefined) {
        try {
          visibilityResult = await api.patch<Record<string, unknown>>(
            `/api/agent/v1/landing-pages/${slug}/section-visibility`,
            { sections: sectionVisibility }
          );
        } catch (err) {
          visibilityError = err instanceof Error ? err.message : String(err);
          if (requested === 1) throw err;
        }
      }

      if (orderError !== undefined && visibilityError !== undefined) {
        throw new Error(`Both section-order and section-visibility updates failed. order: ${orderError}; visibility: ${visibilityError}`);
      }

      const result: Record<string, unknown> = {};
      if (sectionOrder !== undefined) {
        result.order = orderError !== undefined ? { error: orderError } : orderResult;
      }
      if (sectionVisibility !== undefined) {
        result.visibility = visibilityError !== undefined ? { error: visibilityError } : visibilityResult;
      }
      if (orderError !== undefined || visibilityError !== undefined) {
        result.partialFailure = true;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Publish landing page ──────────────────────────────────────────────────
  server.tool(
    "publish_landing_page",
    "Publish a landing page, making it publicly accessible at its URL.",
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/publish`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete landing page ───────────────────────────────────────────────────
  server.tool(
    "delete_landing_page",
    "Permanently delete a landing page. Pass confirm: true to proceed — this is irreversible.",
    {
      slug: z.string().describe("Landing page slug"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}`);
      return {
        content: [{ type: "text" as const, text: `Landing page "${slug}" deleted.` }],
      };
    }
  );

  // ── View draft ────────────────────────────────────────────────────────────
  server.tool(
    "view_lp_draft",
    "View the unpublished draft of a landing page. detail='full' (default) includes full versionData; 'medium' adds sectionKeys/sectionWordCounts; 'short' is id/slug/name/status only.",
    {
      slug: z.string().describe("Landing page slug"),
      detail: detailParam("full"),
    },
    async ({ slug, detail }) => {
      const raw = await api.get<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/draft`);
      const p = raw as LpDraft;
      const proj = {
        short: (row: LpDraft) => pick(row, ["id", "slug", "name", "status"]),
        medium: (row: LpDraft) => ({
          ...pick(row, ["id", "slug", "name", "status"]),
          sectionKeys: sectionKeys(row),
          sectionWordCounts: sectionWordCounts(row),
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── List versions ─────────────────────────────────────────────────────────
  server.tool(
    "list_lp_versions",
    "List all saved versions of a landing page. Default detail='short'. Use view_lp_version to see section content.",
    {
      slug: z.string().describe("Landing page slug"),
      detail: detailParam("short"),
    },
    async ({ slug, detail }) => {
      const raw = await api.get<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/versions`);
      const versions: LpVersionItem[] = Array.isArray(raw)
        ? (raw as unknown as LpVersionItem[])
        : Array.isArray(raw["versions"])
        ? (raw["versions"] as LpVersionItem[])
        : [];
      const proj = {
        short: (row: LpVersionItem) => pick(row, ["id", "name", "createdAt"]),
        medium: (row: LpVersionItem) => pick(row, ["id", "name", "createdAt", "editorId", "description"]),
      };
      const text = JSON.stringify({ count: versions.length, detail, versions: projectList(detail, versions, proj) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── View version ──────────────────────────────────────────────────────────
  server.tool(
    "view_lp_version",
    "View a specific LP version. detail='full' (default) returns full data; 'medium' adds sectionKeys/sectionWordCounts.",
    {
      slug: z.string().describe("Landing page slug"),
      versionId: z.number().int().describe("Numeric version ID from list_lp_versions"),
      detail: detailParam("full"),
    },
    async ({ slug, versionId, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/versions/${versionId}`
      );
      const p = raw as LpVersionDetail;
      const proj = {
        short: (row: LpVersionDetail) => pick(row, ["id", "name", "createdAt"]),
        medium: (row: LpVersionDetail) => ({
          ...pick(row, ["id", "name", "description", "createdAt"]),
          sectionKeys: sectionKeys(row),
          sectionWordCounts: sectionWordCounts(row),
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Restore version ───────────────────────────────────────────────────────
  server.tool(
    "restore_lp_version",
    "Undo/rollback the draft to a prior version. Find valid version IDs via list_lp_versions. This does not touch the published version.",
    {
      slug: z.string().describe("Landing page slug"),
      versionId: z.number().int().describe("Numeric version ID from list_lp_versions to restore as the draft"),
    },
    async ({ slug, versionId }) => {
      const data = await api.put<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/versions/${versionId}`,
        { action: "make-current" }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete version ────────────────────────────────────────────────────────
  server.tool(
    "delete_lp_version",
    "Permanently delete a historical landing page version. Cannot delete the published version or the only remaining version (the server will reject those). Pass confirm: true to proceed.",
    {
      slug: z.string().describe("Landing page slug"),
      versionId: z.number().int().describe("Numeric version ID from list_lp_versions"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug, versionId }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}/versions/${versionId}`);
      return {
        content: [{ type: "text" as const, text: `Version ${versionId} deleted from "${slug}".` }],
      };
    }
  );

  // ─────────────────── Side pages ────────────────────────────────────────────

  // ── List side pages ───────────────────────────────────────────────────────
  server.tool(
    "list_side_pages",
    "List side pages attached to a landing page. Default detail='short'. Heavy JSONB (overrides/config) only at full via view_side_page.",
    {
      slug: z.string().describe("Parent landing page slug"),
      detail: detailParam("short"),
    },
    async ({ slug, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages`
      );
      const pages: SidePageItem[] = Array.isArray(raw["sidePages"])
        ? (raw["sidePages"] as SidePageItem[])
        : Array.isArray(raw)
        ? (raw as unknown as SidePageItem[])
        : [];
      const proj = {
        short: (row: SidePageItem) => pick(row, ["id", "slug", "name", "type", "isPublished"]),
        medium: (row: SidePageItem) =>
          pick(row, ["id", "slug", "name", "type", "isPublished", "publishedAt", "updatedAt"]),
      };
      const text = JSON.stringify({ count: pages.length, detail, sidePages: projectList(detail, pages, proj) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Generate side page (async, AI generator) ──────────────────────────────
  server.tool(
    "generate_side_page",
    [
      "AI-generates a side page under a parent landing page. Async — kicks off the side-page generator and returns `{ success, operationId, operationRowId, pollUrl, sidePageId }`.",
      "This is the GENERATOR (POST /side-pages/generate) — NOT a row creator. Comparison-type briefs may run synchronously and return `sidePageId` directly with no operationId.",
      "Two body modes:",
      "  • freeform: pass `key` + `prompt` (+ optional `keywords`, `selectedSections`, `voiceProfileId`, `sidePageType`).",
      "  • brief: pass `key` + `brief` (structured outline) + optional `briefId` and `roadmapItemId`.",
      "Poll `get_job` until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error).",
    ].join(" "),
    {
      slug: z.string().min(1).describe("Parent landing page slug"),
      key: z.string().min(1).describe("Side-page key (URL slug fragment under the parent LP)"),
      prompt: z
        .string()
        .optional()
        .describe("Freeform-mode generation prompt (omit when passing `brief`)"),
      brief: z
        .unknown()
        .optional()
        .describe("Brief-mode structured outline. When set, this is the canonical payload."),
      keywords: z
        .array(z.string())
        .optional()
        .describe("Freeform-mode: target keywords to weave into the page"),
      sidePageType: z
        .enum(["landing", "text", "comparison"])
        .optional()
        .describe("Defaults to 'landing'. Use 'comparison' only with a persisted comparison briefId."),
      voiceProfileId: z.string().optional().describe("Voice profile to write in"),
      autoAssignAssets: z
        .boolean()
        .optional()
        .describe("Auto-assign brand assets to image slots after generation"),
      briefId: z
        .string()
        .optional()
        .describe("Persisted SeoBrief ID — required for comparison-type generation"),
      roadmapItemId: z.string().optional().describe("Roadmap item ID this side page is fulfilling"),
    },
    async ({ slug, key, prompt, brief, keywords, sidePageType, voiceProfileId, autoAssignAssets, briefId, roadmapItemId }) => {
      const body: Record<string, unknown> = { key };
      if (prompt !== undefined) body.prompt = prompt;
      if (brief !== undefined) body.brief = brief;
      if (keywords !== undefined) body.keywords = keywords;
      if (sidePageType !== undefined) body.sidePageType = sidePageType;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;
      if (autoAssignAssets !== undefined) body.autoAssignAssets = autoAssignAssets;
      if (briefId !== undefined) body.briefId = briefId;
      if (roadmapItemId !== undefined) body.roadmapItemId = roadmapItemId;
      const data = await api.post<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/generate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── View side page ────────────────────────────────────────────────────────
  server.tool(
    "view_side_page",
    "View a side page including sections and rendered HTML. detail='full' (default) includes rendered HTML and full overrides; 'medium' gives summary + overrideSectionKeys; 'short' gives id/slug/name/type/isPublished. Rendered HTML appears only at full.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages)"),
      detail: detailParam("full"),
    },
    async ({ slug, sideKey, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`
      );
      const p = (raw["sidePage"] !== undefined ? raw["sidePage"] : raw) as SidePageDetail;
      const proj = {
        short: (row: SidePageDetail) => pick(row, ["id", "slug", "name", "type", "isPublished"]),
        medium: (row: SidePageDetail) => ({
          ...pick(row, ["id", "slug", "name", "type", "isPublished", "publishedAt", "updatedAt"]),
          overrideSectionKeys:
            row.overrides !== null && typeof row.overrides === "object" && !Array.isArray(row.overrides)
              ? Object.keys(row.overrides as object)
              : [],
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Edit side page ────────────────────────────────────────────────────────
  server.tool(
    "edit_side_page",
    "Update the instructions or metadata of a side page. For section-level edits, use set_side_page_section.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      instructions: z.string().optional().describe("Updated instructions for the AI"),
    },
    async ({ slug, sideKey, instructions }) => {
      const data = await api.patch<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`,
        { instructions }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete side page ──────────────────────────────────────────────────────
  server.tool(
    "delete_side_page",
    "Delete a side page. Pass confirm: true to proceed.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug, sideKey }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`);
      return {
        content: [
          { type: "text" as const, text: `Side page "${sideKey}" deleted from "${slug}".` },
        ],
      };
    }
  );

  // ── Edit side page section ────────────────────────────────────────────────
  server.tool(
    "set_side_page_section",
    "Update the content of a specific section within a side page.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      sectionId: z.string().describe("Section ID from view_side_page"),
      content: z.string().optional().describe("New section content (HTML or markdown)"),
      instructions: z.string().optional().describe("AI-guided edit instructions for this section"),
    },
    async ({ slug, sideKey, sectionId, content, instructions }) => {
      const body: Record<string, unknown> = { sectionId };
      if (content !== undefined) body.content = content;
      if (instructions !== undefined) body.instructions = instructions;
      const data = await api.patch<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/section`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set side page state ───────────────────────────────────────────────────
  server.tool(
    "set_side_page_state",
    "Publish or unpublish a side page. Set published=true to make it live, false to pull it back to draft.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      published: z.boolean().describe("true = publish, false = unpublish"),
    },
    async ({ slug, sideKey, published }) => {
      const data = await api.post<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/state`,
        { published }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
