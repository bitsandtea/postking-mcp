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
import { requireBrandId, getActiveBrandId } from "../state.js";
import { detailParam, project, projectList, pick, truncate } from "../detail.js";
import { brandDashboardUrl } from "../links.js";
import { languageParam, SUPPORTED_LANGUAGE_CODES, LANGUAGE_CODE_LIST_TEXT } from "../languages.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

/**
 * Arbitrary JSON value for section/field writes (set_landing_page_section).
 *
 * `z.any()` renders as an unconstrained `{}` JSON-schema node (no `type`), which
 * some MCP clients / tool-calling layers interpret as "string" and pre-stringify
 * arrays/objects before sending — silently corrupting non-scalar values on the
 * wire (e.g. `tiers: []` arrives as the literal string `"[]"`). Declaring an
 * explicit union gives callers a real `type: array|object|...` to target.
 */
const jsonValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.any()),
  z.record(z.string(), z.any()),
]);

/**
 * Defensive unwrap for callers that pass a JSON-looking string anyway (common,
 * since many agent runtimes stringify tool args). If `value` is a string whose
 * trimmed form looks like a JSON array/object and parses cleanly, unwrap it once
 * so the server receives the real array/object instead of a doubly-encoded string.
 * A literal content string that happens to start with `{`/`[` and also parses as
 * valid JSON is vanishingly unlikely for LP section/field values.
 */
function coerceJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * The 12 built-in landing-page section-order keys. Mirrors PostKing's
 * `SECTION_ORDER_KEYS` (`types/landing-page-shared.types.ts`) — it had drifted
 * and was missing `videos`, which made any `sectionOrder` sent from here
 * silently push the videos section to the bottom (the server appends canonical
 * keys the caller omitted).
 */
const SECTION_ORDER_KEYS = [
  "hero",
  "showcase",
  "videos",
  "howItWorks",
  "features",
  "categoryExplorer",
  "replacesStack",
  "comparisonMatrix",
  "cta",
  "faq",
  "pricing",
  "roiCalculator",
] as const;

/**
 * A landing page may also carry freeform HTML sections (feature 117), keyed
 * under `content.customHtml` and ordered as `customHtml:<id>`.
 */
const CUSTOM_HTML_KEY_REGEX = /^customHtml:[a-z0-9][a-z0-9-]{0,39}$/;

const sectionOrderKeySchema = z.union([
  z.enum(SECTION_ORDER_KEYS),
  z
    .string()
    .regex(
      CUSTOM_HTML_KEY_REGEX,
      "freeform section keys look like customHtml:<id> (lowercase letters, digits, hyphens)"
    ),
]);

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
  previewUrl?: string;
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
  _meta?: { previewUrl?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface RawHtmlInternalLinkAudit {
  href?: string;
  slug?: string;
  existingSidePage?: boolean;
  [k: string]: unknown;
}

interface RawHtmlImportReport {
  externalHosts?: string[];
  relativeAssetPaths?: string[];
  placeholders?: string[];
  internalLinks?: RawHtmlInternalLinkAudit[];
  themeExtracted?: boolean;
  truncated?: boolean;
  extractability?: { verdict?: "ok" | "warn" | "blocked"; reasons?: string[] };
  [k: string]: unknown;
}

interface RawHtmlImportResult {
  landingPage?: { id?: string; slug?: string; [k: string]: unknown };
  report?: RawHtmlImportReport;
  [k: string]: unknown;
}

interface LpVersionItem {
  id?: string | number;
  name?: string;
  createdAt?: string;
  editorId?: string;
  description?: string;
  previewUrl?: string;
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
  previewUrl?: string;
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
  currentVersionId?: number;
  publishedVersionId?: number;
  overrides?: unknown;
  config?: unknown;
  slotMap?: unknown;
  siteMetadata?: unknown;
  previewUrl?: string;
  liveUrl?: string;
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
  currentVersionId?: number;
  publishedVersionId?: number;
  overrides?: unknown;
  config?: unknown;
  slotMap?: unknown;
  siteMetadata?: unknown;
  rendered?: string;
  renderLinks?: unknown;
  previewUrl?: string;
  liveUrl?: string;
  [k: string]: unknown;
}

interface SidePageVersionItem {
  id?: string | number;
  name?: string;
  createdAt?: string;
  editorId?: string;
  description?: string;
  source?: string;
  [k: string]: unknown;
}

interface SidePageVersionDetail {
  type?: string;
  overrides?: unknown;
  siteMetadata?: unknown;
  slotMap?: unknown;
  config?: unknown;
  _meta?: {
    versionId?: string | number;
    isCurrent?: boolean;
    isPublished?: boolean;
    createdAt?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface VibeEditChange {
  index?: number;
  path?: string;
  before?: unknown;
  after?: unknown;
  [k: string]: unknown;
}

interface VibeEditProgressDetail {
  at?: string;
  [k: string]: unknown;
}

interface VibeEditStatus {
  status?: string;
  progress?: number | string | VibeEditProgressDetail;
  stale?: boolean;
  baseVersionId?: string | number;
  currentVersionId?: string | number;
  changesCount?: number;
  credits?: unknown;
  changes?: VibeEditChange[];
  editedData?: unknown;
  error?: string;
  createdAt?: string;
  elapsedSeconds?: number;
  stalled?: boolean;
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
    "Lists landing pages. Default detail='short' (id/slug/name/status/languageCode) — languageCode matters on a brand publishing in more than one language (see get_brand_languages), since pages in different languages are otherwise indistinguishable. Use view_landing_page for full content.",
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
        short: (row: LpListItem) => pick(row, ["id", "slug", "name", "status", "languageCode"]),
        medium: (row: LpListItem) =>
          pick(row, ["id", "slug", "name", "status", "languageCode", "updatedAt", "currentVersionId", "publishedVersionId", "webUrl"]),
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
      language: languageParam("Also drives the slug/URL wording for the generated page."),
      brandId: brandOpt,
    },
    async ({ topic, slug, voiceProfileId, language, brandId }) => {
      const id = requireBrandId(brandId);
      const pageSlug = slug ?? topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      await api.post<Record<string, unknown>>(`/api/agent/v1/brands/${id}/landing-pages`, { slug: pageSlug, brandId: id, name: topic });
      const genData = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${pageSlug}/generate`, {
        instructions: topic,
        voiceProfileId,
        // Left off the body entirely when unset so the brand default applies.
        language,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ slug: pageSlug, ...genData }, null, 2) }] };
    }
  );

  // ── Import landing page from raw HTML ─────────────────────────────────────
  server.tool(
    "import_landing_page_html",
    [
      "Bring-your-own-HTML: import an existing landing page from pasted HTML or a live URL. Synchronous — no polling needed.",
      "Pass exactly one of `html` (paste the full page source) or `url` (fetch and import from a live page).",
      "By default creates a brand-new landing page (optionally with `name`; the slug is always auto-generated). Pass `convertExistingSlug` instead to overwrite an existing landing page's content with the imported HTML.",
      "Set `createMissingSidePages` to true to auto-create stub side pages for internal links discovered in the HTML that don't already exist.",
      "Returns { landingPage: {id, slug}, report } where report audits the import: externalHosts (third-party domains referenced), relativeAssetPaths (local asset paths that may need re-hosting), placeholders (unresolved template tokens found), internalLinks (each { href, slug, existingSidePage }), themeExtracted (whether a theme was inferred from the HTML), truncated (whether the source HTML was cut down to fit limits), and extractability ({ verdict: 'ok'|'warn', reasons } — 'warn' means framework hydration scripts won't load post-import but static content still renders).",
      "If the source is a client-rendered app shell whose content depends entirely on framework scripts that can't be hosted here (e.g. a bare Next.js/React app shell), the import is refused before anything is persisted — this tool returns a non-throwing result { error: 'not_extractable', message, reasons } instead. Relay the reasons to the user and suggest pasting a static/exported HTML instead, or publishing directly from their site builder.",
      "Example: import_landing_page_html({ url: 'https://example.com/pricing', name: 'Pricing' }).",
    ].join(" "),
    {
      brandId: brandOpt,
      html: z.string().optional().describe("Full HTML source to import (paste mode). Provide this or `url`, not both."),
      url: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Live page URL to fetch and import (URL mode). Provide this or `html`, not both. Scheme-less domains (e.g. \"example.com\") are accepted and default to https."
        ),
      name: z.string().optional().describe("Display name for the new landing page"),
      convertExistingSlug: z
        .string()
        .optional()
        .describe("Slug of an EXISTING landing page to overwrite with the imported HTML, instead of creating a new one"),
      createMissingSidePages: z
        .boolean()
        .optional()
        .describe("Auto-create stub side pages for internal links found in the HTML that don't already exist"),
    },
    async ({ brandId, html, url, name, convertExistingSlug, createMissingSidePages }) => {
      if (!html && !url) {
        throw new Error("Provide either `html` (paste) or `url` (fetch).");
      }
      const id = brandId ?? getActiveBrandId() ?? undefined;
      const body: Record<string, unknown> = {};
      if (id !== undefined) body.brandId = id;
      if (html !== undefined) body.html = html;
      if (url !== undefined) body.url = url;
      if (name !== undefined) body.name = name;
      if (convertExistingSlug !== undefined) body.convertExistingSlug = convertExistingSlug;
      if (createMissingSidePages !== undefined) body.createMissingSidePages = createMissingSidePages;
      try {
        const data = await api.post<RawHtmlImportResult>("/api/agent/v1/landing-pages/import-html", body);
        const result: Record<string, unknown> = { landingPage: data.landingPage, report: data.report };
        if (id) result.dashboardUrl = brandDashboardUrl(id, "landing_pages");
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ApiError && err.status === 422 && err.code === "NOT_EXTRACTABLE") {
          const reasons = Array.isArray(err.details?.reasons) ? (err.details!.reasons as string[]) : [];
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "not_extractable",
                  message:
                    (err.message ||
                      "This page can't be imported: it's a client-rendered app whose content depends on framework scripts that can't be hosted here.") +
                    " Suggest to the user: paste static/exported HTML instead (e.g. a static-site export, or a pre-rendered page's \"View Source\"), or publish directly from their site builder instead of importing.",
                  reasons,
                }),
              },
            ],
          };
        }
        throw err;
      }
    }
  );

  // ── View landing page ─────────────────────────────────────────────────────
  server.tool(
    "view_landing_page",
    "Fetch a landing page by slug. detail='full' (default) returns full data JSONB plus previewUrl (public GUI preview link) and webUrl (dashboard editor link); 'medium' returns summary + sectionKeys/sectionWordCounts + previewUrl + webUrl; 'short' returns id/slug/name/status. Section bodies and rendered HTML appear only at full.",
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
          ...pick(row, ["id", "slug", "name", "status", "updatedAt", "currentVersionId", "publishedVersionId", "webUrl", "previewUrl"]),
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
      language: languageParam("Regenerates the page in this language; omit to keep the page on the brand's configured content language."),
    },
    async ({ slug, voiceProfileId, instructions, sections, language }) => {
      const body: Record<string, unknown> = {};
      if (voiceProfileId) body.voiceProfileId = voiceProfileId;
      if (instructions) body.instructions = instructions;
      if (sections?.length) body.sections = sections;
      if (language) body.language = language;
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
      "Vibe edits typically complete in 60-120 seconds but can take up to 15 minutes. The 'Calling AI service' step covers most of the runtime — seeing it repeatedly does NOT mean the operation is stuck. Keep polling get_vibe_edit_status for up to 15 minutes before treating the operation as failed; the status response includes elapsedSeconds and a progress heartbeat, and the server itself reports status 'failed' (with stalled: true) if the worker actually dies.",
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
      language: languageParam("Regenerates the edited content in this language; omit to keep the page on the brand's configured content language."),
    },
    async ({ slug, instructions, scope, sectionId, language }) => {
      if (scope === "section" && !sectionId) {
        throw new Error("sectionId is required when scope='section'");
      }
      const body: Record<string, unknown> = { instructions };
      if (scope) body.scope = scope;
      if (sectionId) body.sectionId = sectionId;
      if (language) body.language = language;
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/ai-edit`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Get vibe edit status ──────────────────────────────────────────────────
  server.tool(
    "get_vibe_edit_status",
    [
      "Poll vibe (AI) edit session status. detail='medium' (default) is the REVIEW view: { status, progress, stale, baseVersionId, currentVersionId, changesCount, credits, changes, error, elapsedSeconds, createdAt, stalled }",
      "where each `changes` entry is { index, path, before, after } (before/after truncated to 200 chars) — use these `index`/`path` values to select a subset in apply_vibe_edit.",
      "'short' returns just { status, progress, error, elapsedSeconds, stalled }. 'full' returns the raw payload including the untruncated editedData.",
      "`error` is populated when status is 'failed' and carries the failure reason — surface it to the user instead of just reporting 'failed'.",
      "Vibe edits typically complete in 60-120 seconds but can take up to 15 minutes — do NOT treat repeated 'processing'/'Calling AI service' progress as stuck. `createdAt` is when the operation started, `elapsedSeconds` is seconds since then, and `progress.at` is a heartbeat timestamp refreshed every ≤30s by a healthy worker. Only treat the edit as dead when status is 'failed' (server-detected, including `stalled: true` when the worker died) OR elapsedSeconds exceeds 900 — keep polling otherwise.",
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
        short: (row: VibeEditStatus) => pick(row, ["status", "progress", "error", "elapsedSeconds", "stalled"]),
        medium: (row: VibeEditStatus) => ({
          ...pick(row, [
            "status",
            "progress",
            "stale",
            "baseVersionId",
            "currentVersionId",
            "changesCount",
            "error",
            "elapsedSeconds",
            "createdAt",
            "stalled",
          ]),
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
      "Freeform HTML sections live at section='customHtml' as a map of id -> { name?, html }. Set one with field='<id>' and value={ name, html }, or replace the whole map with replaceSection=true. The html is sanitized server-side and REJECTED (not stripped) if it breaks the rules: only blk-* classes, no script/style/iframe/on* handlers, style may set only --blk-* custom properties, and every <img>/<video> src must be an https:// URL on try.postking.app or cdn.postking.app. Place each one in the page order with set_lp_section_layout using the key 'customHtml:<id>'.",
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
      value: jsonValueSchema.describe(
        "New value for the field (or the whole section when replaceSection=true). May be any JSON type — string, number, boolean, null, array, or object — sent verbatim, not stringified."
      ),
      replaceSection: z.boolean().optional().describe("Replace the entire section with `value` instead of setting one field"),
      name: z.string().optional().describe("Name for the new version"),
      description: z.string().optional().describe("Description for the new version"),
    },
    async ({ slug, section, field, value, replaceSection, name, description }) => {
      if (!replaceSection && field === undefined) {
        throw new Error("field is required unless replaceSection=true");
      }
      const resolvedValue = coerceJsonValue(value);
      const body: Record<string, unknown> = replaceSection
        ? { replaceSection: true, section, value: resolvedValue }
        : { section, field, value: resolvedValue, nested: true };
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
      `Valid section-order keys (all 12 built-ins): ${SECTION_ORDER_KEYS.join(", ")}.`,
      "A page's freeform HTML sections are ordered too: pass 'customHtml:<id>' for each id in content.customHtml. Omitting one appends it at the end.",
      "sectionVisibility keys are the toggleable subset of the above.",
      "When both are given, order is attempted first, then visibility — each is applied independently, so one can succeed while the other fails.",
      "The result always reports both outcomes: { order: <result>|{error}, visibility: <result>|{error}, partialFailure: true } if only one part failed.",
      "This tool only throws if every requested part fails (or if a single requested part fails).",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      sectionOrder: z
        .array(sectionOrderKeySchema)
        .optional()
        .describe(
          "Full ordered list of section keys — the 12 built-ins plus any 'customHtml:<id>' freeform sections"
        ),
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
    "View the unpublished draft of a landing page. detail='full' (default) includes full versionData plus previewUrl (public GUI preview link, ?version= form); 'medium' adds sectionKeys/sectionWordCounts + previewUrl; 'short' is id/slug/name/status only.",
    {
      slug: z.string().describe("Landing page slug"),
      detail: detailParam("full"),
    },
    async ({ slug, detail }) => {
      const raw = await api.get<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/draft`);
      const p = raw as LpDraft;
      const previewUrl = p._meta?.previewUrl;
      const proj = {
        short: (row: LpDraft) => pick(row, ["id", "slug", "name", "status"]),
        medium: (row: LpDraft) => ({
          ...pick(row, ["id", "slug", "name", "status"]),
          sectionKeys: sectionKeys(row),
          sectionWordCounts: sectionWordCounts(row),
          previewUrl,
        }),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── List versions ─────────────────────────────────────────────────────────
  server.tool(
    "list_lp_versions",
    "List all saved versions of a landing page. Default detail='short'. Each version includes previewUrl (public GUI preview link — the published version's form when that version is the live one, otherwise the ?version= form); the top-level previewUrl is for the current draft. Use view_lp_version to see section content.",
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
      const previewUrl = typeof raw["previewUrl"] === "string" ? raw["previewUrl"] : null;
      const proj = {
        short: (row: LpVersionItem) => pick(row, ["id", "name", "createdAt", "previewUrl"]),
        medium: (row: LpVersionItem) => pick(row, ["id", "name", "createdAt", "editorId", "description", "previewUrl"]),
      };
      const text = JSON.stringify({
        count: versions.length,
        detail,
        previewUrl,
        versions: projectList(detail, versions, proj),
      });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── View version ──────────────────────────────────────────────────────────
  server.tool(
    "view_lp_version",
    "View a specific LP version. detail='full' (default) returns full data plus previewUrl (public GUI preview link — the published form if this is the live version, otherwise the ?version= form); 'medium' adds sectionKeys/sectionWordCounts + previewUrl.",
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
          ...pick(row, ["id", "name", "description", "createdAt", "previewUrl"]),
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
    "List side pages attached to a landing page. Default detail='short'. Heavy JSONB (overrides/config) only at full via view_side_page. Every detail level includes previewUrl (a browser-openable draft-preview link, always available) and liveUrl (a browser-openable public link, present only when a custom domain is connected). medium/full also include currentVersionId (the draft) and publishedVersionId (the live version) per row — compare them to spot pages with unpublished draft edits without a second call.",
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
        short: (row: SidePageItem) => pick(row, ["id", "slug", "name", "type", "isPublished", "previewUrl", "liveUrl"]),
        medium: (row: SidePageItem) =>
          pick(row, [
            "id",
            "slug",
            "name",
            "type",
            "isPublished",
            "publishedAt",
            "updatedAt",
            "currentVersionId",
            "publishedVersionId",
            "previewUrl",
            "liveUrl",
          ]),
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
      "  • freeform: pass `key` + `prompt` (+ optional `keywords`, `selectedSections`, `voiceProfileId`, `sidePageType`). Freeform now writes real section-level content (hero/features/showcase/faq/cta), not just metadata.",
      "  • brief: pass `key` + `brief` (structured outline) + optional `briefId` and `roadmapItemId`.",
      "Poll `get_job` with the returned `operationId` until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error); the generated page's sections will be populated once complete. The completed job's result includes previewUrl (browser-openable draft-preview link, always present) and liveUrl (browser-openable public link, present only when a custom domain is connected).",
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
      selectedSections: z
        .array(z.string())
        .optional()
        .describe("Freeform-mode: restrict generation to these section ids (e.g. hero, features, showcase, faq, cta, pricing). Omit to generate all default sections."),
      sidePageType: z
        .enum(["landing", "text", "comparison", "custom"])
        .optional()
        .describe(
          "Defaults to 'landing'. Use 'comparison' only with a persisted comparison briefId. Use 'custom' for the block-model page type (an ordered blocks[] array — see list_block_types/add_block/edit_block/delete_block/reorder_blocks) when the page needs a shape the fixed section list can't express."
        ),
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
    async ({ slug, key, prompt, brief, keywords, selectedSections, sidePageType, voiceProfileId, autoAssignAssets, briefId, roadmapItemId }) => {
      const body: Record<string, unknown> = { key };
      if (prompt !== undefined) body.prompt = prompt;
      if (brief !== undefined) body.brief = brief;
      if (keywords !== undefined) body.keywords = keywords;
      if (selectedSections !== undefined) body.selectedSections = selectedSections;
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

  // ── Import side page from raw HTML ────────────────────────────────────────
  server.tool(
    "import_side_page_html",
    [
      "Bring-your-own-HTML: import a side page under a parent landing page directly from a live URL or pasted HTML. Pass exactly one of `url` or `html`.",
      "When using `url`, PostKing fetches the page server-side — you do NOT need to download or paste the HTML yourself; just pass the URL.",
      "`sidePageSlug` (maps to the request body's `slug`) sets the URL-slug fragment for the new side page under the parent LP. With `url` it's optional — derived from the URL's path when omitted. With `html` it's REQUIRED, since there's no URL to derive a slug from.",
      "The outcome depends on the PARENT landing page's type — two possible modes:",
      "  • Parent is a raw-HTML page: import runs SYNCHRONOUSLY. Returns 201 with { sidePage: { id, slug }, mode: 'import', previewUrl?, liveUrl? } — nothing further to do.",
      "  • Parent is a sectioned page: the source page's text is extracted and seeds an ASYNC side-page generation. Returns 202 with { mode: 'generate', operationId, key } — poll get_job(operationId) exactly like generate_side_page, until state is 'completed' (or 'failed'/'partially_failed'/'cancelled'). Do NOT fabricate the page's content yourself while it's running; the completed job's result carries previewUrl/liveUrl once done.",
      "previewUrl is a browser-openable draft-preview link (always available once the page exists); liveUrl is a browser-openable public link, present only when a custom domain is connected.",
      "409 means a side page with that slug already exists under this parent — pick a different sidePageSlug or edit the existing page (edit_side_page / set_side_page_section) instead. 400 covers invalid URLs or URLs blocked for security reasons (e.g. SSRF-blocked internal/private-network addresses).",
    ].join(" "),
    {
      slug: z.string().min(1).describe("Parent landing page slug"),
      url: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Live page URL to fetch and import (URL mode). Provide this or `html`, not both. PostKing fetches it server-side."
        ),
      html: z.string().optional().describe("Full HTML source to import (paste mode). Provide this or `url`, not both."),
      sidePageSlug: z
        .string()
        .optional()
        .describe(
          "Desired URL-slug fragment for the new side page under the parent LP (maps to the request body's `slug`). Optional with `url` (derived from the URL's path when omitted); REQUIRED with `html`."
        ),
      voiceProfileId: z.string().optional().describe("Voice profile to write in (used when the parent is a sectioned page and generation runs)"),
      autoAssignAssets: z
        .boolean()
        .optional()
        .describe("Auto-assign brand assets to image slots after generation (used when the parent is a sectioned page and generation runs)"),
    },
    async ({ slug, url, html, sidePageSlug, voiceProfileId, autoAssignAssets }) => {
      if (!url && !html) {
        throw new Error("Provide either `url` (fetch) or `html` (paste).");
      }
      if (url && html) {
        throw new Error("Provide only one of `url` or `html`, not both.");
      }
      if (html && !sidePageSlug) {
        throw new Error("`sidePageSlug` is required when importing from raw `html` — there's no URL to derive it from.");
      }
      const body: Record<string, unknown> = {};
      if (url !== undefined) body.url = url;
      if (html !== undefined) body.html = html;
      if (sidePageSlug !== undefined) body.slug = sidePageSlug;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;
      if (autoAssignAssets !== undefined) body.autoAssignAssets = autoAssignAssets;
      const data = await api.post<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/import-html`,
        body
      );
      const out: Record<string, unknown> = { ...data };
      if (data.mode === "generate") {
        out.instruction =
          "Parent is a sectioned page — the imported page's text seeded an async side-page generation. Poll get_job with the returned operationId until state is 'completed' (or 'failed'/'partially_failed'/'cancelled'); the generated side page's sections and previewUrl/liveUrl will be populated once complete. Do NOT fabricate the page's content yourself while this is running.";
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    }
  );

  // ── View side page ────────────────────────────────────────────────────────
  server.tool(
    "view_side_page",
    "View a side page including sections and rendered HTML. detail='full' (default) includes rendered HTML and full overrides (use this to read a section's typed shape before editing it with set_side_page_section); 'medium' gives summary + overrideSectionKeys (the section ids you can pass to set_side_page_section); 'short' gives id/slug/name/type/isPublished. Rendered HTML appears only at full. Every detail level includes previewUrl (browser-openable draft-preview link, always available) and liveUrl (browser-openable public link, present only when a custom domain is connected). medium/full also include currentVersionId (the draft) and publishedVersionId (the live version) — a mismatch means there are unpublished draft edits.",
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
        short: (row: SidePageDetail) => pick(row, ["id", "slug", "name", "type", "isPublished", "previewUrl", "liveUrl"]),
        medium: (row: SidePageDetail) => ({
          ...pick(row, [
            "id",
            "slug",
            "name",
            "type",
            "isPublished",
            "publishedAt",
            "updatedAt",
            "currentVersionId",
            "publishedVersionId",
            "previewUrl",
            "liveUrl",
          ]),
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
    "Update a side page's page-level metadata and, for type:\"text\" pages only, its content. " +
      "Metadata (any side-page type): `name` (display title, shown in auto-generated footer/nav 'Solutions' links and breadcrumbs), " +
      "`newKey` (rename the URL-slug fragment; old URL 404s, no redirect; internal references are rewritten in the background), " +
      "and `instructions` (stored as an annotation for future context — does NOT trigger an AI edit). " +
      "Content — type:\"text\" pages ONLY: `title` and/or `htmlContent`. Text side pages store a flat {title, htmlContent} " +
      "document, not per-section overrides, so this is the direct way to write their content — landing/comparison pages have " +
      "no `title`/`htmlContent` fields and must use set_side_page_section (or set_side_page_section with instructions-only for " +
      "an AI rewrite of a text page's whole document) instead. Passing only one of title/htmlContent fetches and preserves the " +
      "other automatically, so a partial write never clobbers the unset field. " +
      "Every edit creates a new draft version (see list_side_page_versions / restore_side_page_version) — nothing here is " +
      "destructive, any write (including a bad title/htmlContent edit) can be undone by restoring a prior version. On a " +
      "published page, edits stay draft-only until set_side_page_state({published:true}) publishes them. When newKey triggers " +
      "a reference rewrite, the response includes slugRewriteOperationId — poll it to confirm the cascade finished.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      instructions: z.string().optional().describe("Updated instructions for the AI"),
      name: z
        .string()
        .optional()
        .describe(
          "New display title for the side page. This is the title shown in auto-generated footer/nav 'Solutions' links and breadcrumbs. Changing it updates those links automatically."
        ),
      newKey: z
        .string()
        .optional()
        .describe(
          "New URL-slug fragment to RENAME the side page's key. The old URL will stop working (404) after rename — there is no redirect. Existing internal links from blogs/other pages to this page are rewritten automatically in the background (poll the returned slugRewriteOperationId)."
        ),
      updateReferences: z
        .boolean()
        .optional()
        .describe(
          "When renaming via newKey, rewrite existing internal references (blog backlinks, internalLinks) to point at the new slug. Defaults to true; set false to skip the cascade."
        ),
      title: z
        .string()
        .optional()
        .describe(
          "type:\"text\" pages only: new page title (part of the flat {title, htmlContent} content document — different from `name`, which is the nav/footer display label). If `htmlContent` isn't also passed, the current htmlContent is fetched and preserved. Ignored for landing/comparison pages — use set_side_page_section there."
        ),
      htmlContent: z
        .string()
        .optional()
        .describe(
          "type:\"text\" pages only: new HTML body (part of the flat {title, htmlContent} content document). If `title` isn't also passed, the current title is fetched and preserved. Ignored for landing/comparison pages — use set_side_page_section there."
        ),
    },
    async ({ slug, sideKey, instructions, name, newKey, updateReferences, title, htmlContent }) => {
      const body: Record<string, unknown> = {};
      if (instructions !== undefined) body.instructions = instructions;
      if (name !== undefined) body.name = name;
      if (newKey !== undefined) {
        body.slug = newKey;
        body.updateReferences = updateReferences !== undefined ? updateReferences : true;
      }
      if (title !== undefined || htmlContent !== undefined) {
        // The underlying PATCH replaces `overrides` WHOLESALE (it does not
        // deep-merge) and text pages require both `title` and `htmlContent`
        // together (SidePageContentTextSchema) — so a caller passing only
        // one field needs the other fetched first, or the write 400s / wipes
        // the unset field.
        let currentTitle: string | undefined;
        let currentHtmlContent: string | undefined;
        if (title === undefined || htmlContent === undefined) {
          const current = await api.get<Record<string, unknown>>(
            `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`
          );
          const currentOverrides = (current["overrides"] ?? {}) as Record<string, unknown>;
          currentTitle = typeof currentOverrides["title"] === "string" ? (currentOverrides["title"] as string) : undefined;
          currentHtmlContent =
            typeof currentOverrides["htmlContent"] === "string" ? (currentOverrides["htmlContent"] as string) : undefined;
        }
        body.overrides = {
          title: title !== undefined ? title : currentTitle,
          htmlContent: htmlContent !== undefined ? htmlContent : currentHtmlContent,
        };
      }
      const data = await api.patch<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`,
        body
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
    "Update one section of a side page with STRUCTURED, typed fields (not a content string). " +
      "The write must match the section's real shape or it is rejected with a 400 validation error. " +
      "Landing sections use typed objects, e.g. hero → { title: { prefix, suffix }, description, testimonials: [...] }; " +
      "comparison sections (matrix, verdict, scorecard, decisionTree, priceCalculator, competitorClaims, ...) use their comparison-schema shape. " +
      "Use view_side_page(detail:'full') first to see the current section shape, then send the same shape back with your edits. " +
      "Pass EITHER `fields` (a partial section object merged onto the current section) OR `field` (a dot-path) + `value` for a single nested change, OR `instructions` alone for a natural-language edit (the server runs an AI pass scoped to this section). " +
      "type:\"text\" pages: there is no per-section nesting — the whole page is one flat {title, htmlContent} document. `sectionId` is accepted for symmetry (e.g. \"content\"/\"htmlContent\"/\"title\") but every edit applies to the whole document: pass fields:{title,htmlContent}, field:\"title\"|\"htmlContent\"+value, or instructions alone for an AI rewrite of the whole page. edit_side_page's title/htmlContent params are a simpler direct-write shortcut for the same document. " +
      "Every edit creates a new draft version (like landing-page section edits) — see list_side_page_versions / restore_side_page_version; on a published page, edits stay draft-only until set_side_page_state({published:true}) publishes them.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      sectionId: z.string().describe("Section ID from view_side_page (e.g. hero, features, matrix, verdict)"),
      fields: z
        .record(z.string(), jsonValueSchema)
        .optional()
        .describe(
          "Structured partial section object, shallow-merged onto the current section. Must conform to the section's typed shape."
        ),
      field: z
        .string()
        .optional()
        .describe("Dot-path to a single nested field (e.g. 'title.prefix'). Requires `value`."),
      value: jsonValueSchema
        .optional()
        .describe("New value for the single `field` above."),
      instructions: z
        .string()
        .optional()
        .describe(
          "Natural-language edit instructions. When provided alone (no fields/field), triggers an AI pass that rewrites this section's content according to the instructions. When combined with fields/field, stored only as an annotation for future context — no AI pass runs."
        ),
      language: languageParam(
        "Only consulted when `instructions` triggers an AI edit pass — ignored for structured fields/field writes, which never translate anything."
      ),
    },
    async ({ slug, sideKey, sectionId, fields, field, value, instructions, language }) => {
      const body: Record<string, unknown> = { sectionId };
      if (fields !== undefined) body.fields = coerceJsonValue(fields);
      if (field !== undefined) body.field = field;
      if (value !== undefined) body.value = coerceJsonValue(value);
      if (instructions !== undefined) body.instructions = instructions;
      if (language) body.language = language;
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
    "Publish or unpublish a side page. published:true publishes the CURRENT DRAFT — it sets the published pointer to the latest draft version, which is how you make draft edits (from edit_side_page / set_side_page_section) live. published:false hides the page publicly but keeps the last-published version marker, so re-publishing with no further edits restores it instantly. The response includes `publishedVersionId` — the version now live (unchanged from before on unpublish) — so you know exactly which version is public without a follow-up view_side_page call.",
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

  // ── List side page versions ───────────────────────────────────────────────
  server.tool(
    "list_side_page_versions",
    "List all saved versions of a side page. Default detail='short'. Always includes top-level currentVersionId (the draft) and publishedVersionId (the live version) so an agent can tell draft vs. live without a second call. Use view_side_page_version to see section content.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      detail: detailParam("short"),
    },
    async ({ slug, sideKey, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/versions`
      );
      const versions: SidePageVersionItem[] = Array.isArray(raw["versions"])
        ? (raw["versions"] as SidePageVersionItem[])
        : Array.isArray(raw)
        ? (raw as unknown as SidePageVersionItem[])
        : [];
      const sidePageId = raw["sidePageId"];
      const currentVersionId = raw["currentVersionId"];
      const publishedVersionId = raw["publishedVersionId"];
      const proj = {
        short: (row: SidePageVersionItem) => pick(row, ["id", "name", "createdAt", "source"]),
        medium: (row: SidePageVersionItem) =>
          pick(row, ["id", "name", "createdAt", "source", "editorId", "description"]),
      };
      const text = JSON.stringify({
        count: versions.length,
        detail,
        sidePageId,
        currentVersionId,
        publishedVersionId,
        versions: projectList(detail, versions, proj),
      });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── View side page version ────────────────────────────────────────────────
  server.tool(
    "view_side_page_version",
    "View a specific side-page version snapshot. detail='full' (default) returns the complete snapshot { type, overrides, siteMetadata, slotMap, config } plus _meta { versionId, isCurrent, isPublished, createdAt }; 'medium' gives type + _meta + overrideSectionKeys (section ids only, no content); 'short' gives just _meta.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      versionId: z.number().int().describe("Numeric version ID from list_side_page_versions"),
      detail: detailParam("full"),
    },
    async ({ slug, sideKey, versionId, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/versions/${versionId}`
      );
      const p = raw as SidePageVersionDetail;
      const proj = {
        short: (row: SidePageVersionDetail) => ({ _meta: row._meta }),
        medium: (row: SidePageVersionDetail) => ({
          type: row.type,
          _meta: row._meta,
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

  // ── Restore side page version ─────────────────────────────────────────────
  server.tool(
    "restore_side_page_version",
    "Restore a side page's draft to a prior version. Find valid version IDs via list_side_page_versions. This only changes the DRAFT — it moves currentVersionId forward to a new version copied from the target (forward history is never deleted). The live/public page is unaffected until you publish again via set_side_page_state({ published: true }).",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      versionId: z.number().int().describe("Numeric version ID from list_side_page_versions to restore as the draft"),
    },
    async ({ slug, sideKey, versionId }) => {
      const data = await api.put<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/versions/${versionId}`,
        { action: "restore" }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete side page version ──────────────────────────────────────────────
  server.tool(
    "delete_side_page_version",
    "Permanently delete a historical side-page version. Deleting the current (draft) version is allowed and repoints the draft to the newest remaining version. Cannot delete the published (live) version or the only remaining version — the server will reject those and the rejection reason is returned as-is. Pass confirm: true to proceed.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      versionId: z.number().int().describe("Numeric version ID from list_side_page_versions"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug, sideKey, versionId }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/versions/${versionId}`);
      return {
        content: [
          { type: "text" as const, text: `Version ${versionId} deleted from side page "${sideKey}" on "${slug}".` },
        ],
      };
    }
  );

  // ─────────────────── Asset slots ────────────────────────────────────────────

  // ── List asset slots ──────────────────────────────────────────────────────
  server.tool(
    "list_asset_slots",
    "List the asset slots (image/video placeholders) for a landing page or side page, with each slot's current asset assignment. Use this to discover valid slotKeys before calling assign_asset_to_slot. Pass sidePageSlug to inspect a side page's slots.",
    {
      slug: z.string().describe("Landing page slug"),
      sidePageSlug: z.string().optional().describe("Side page slug — inspect this side page's slots instead of the main LP's"),
      pageKey: z.string().optional().describe("Page key within the LP (defaults to 'main'; ignored when sidePageSlug is set)"),
    },
    async ({ slug, sidePageSlug, pageKey }) => {
      const qs = new URLSearchParams();
      if (sidePageSlug !== undefined) qs.set("sidePageSlug", sidePageSlug);
      if (pageKey !== undefined) qs.set("pageKey", pageKey);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/assets/slots${suffix}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Assign asset to slot ──────────────────────────────────────────────────
  server.tool(
    "assign_asset_to_slot",
    "Assign, reassign, or clear the asset in a landing-page or side-page slot. slotKey is a dotted key like 'hero.backgroundVideo' or 'cta.image' (discover valid keys with list_asset_slots). For array slots pass assetIds; for single slots pass assetId. The asset must already be in the brand's library (see list_assets / upload_asset / import_asset_from_url) and match the slot's media type. Pass sidePageSlug to target a side page. Set clear:true (or assetId:null) to empty the slot. Synchronous — the change applies immediately, no polling. Main-LP changes create a new draft version.",
    {
      slug: z.string().describe("Landing page slug"),
      slotKey: z.string().describe("Dotted slot key, e.g. 'hero.backgroundVideo' or 'cta.image' (from list_asset_slots)"),
      assetId: z.string().nullable().optional().describe("Asset ID for a single (non-array) slot. Pass null to clear the slot."),
      assetIds: z.array(z.string()).nullable().optional().describe("Asset IDs for an array slot. Pass an empty array (or null) to clear the slot."),
      sidePageSlug: z.string().optional().describe("Side page slug — target this side page's slot instead of the main LP's"),
      pageKey: z.string().optional().describe("Page key within the LP (defaults to 'main'; ignored when sidePageSlug is set)"),
      clear: z.boolean().optional().describe("Set true to empty the slot"),
    },
    async ({ slug, slotKey, assetId, assetIds, sidePageSlug, pageKey, clear }) => {
      const body: Record<string, unknown> = { slotKey };
      if (assetId !== undefined) body.assetId = assetId;
      if (assetIds !== undefined) body.assetIds = assetIds;
      if (sidePageSlug !== undefined) body.sidePageSlug = sidePageSlug;
      if (pageKey !== undefined) body.pageKey = pageKey;
      if (clear !== undefined) body.clear = clear;
      const data = await api.post<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/assets/assign`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─────────────────── Translations (110-multilingual-brand) ─────────────────

  // ── Read a page's translation group ───────────────────────────────────────
  server.tool(
    "get_landing_page_translations",
    [
      "Read the translation group a landing page belongs to — the set of language variants of the same page, linked by a shared group id.",
      "Returns { slug, languageCode, pathPrefix, translationGroupId, isTranslationSource, variants: [...] }. `variants` lists the OTHER language variants in the group (empty if this page has no translations yet). `pathPrefix` is null for the brand's default language (served at the domain root) and /{languageCode} for every other language.",
      "Use before create_landing_page_translation to check whether a variant in the target language already exists.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.get<unknown>(`/api/agent/v1/landing-pages/${slug}/translations`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Create a new language variant ─────────────────────────────────────────
  server.tool(
    "create_landing_page_translation",
    [
      "Create a new language variant of a landing page, linked into a shared translation group with the source page.",
      "This only creates an empty DRAFT page row (correct slug suffix and /{languageCode} path prefix) — it does NOT translate any content. Use the `pullFromSourceUrl` in the response as the next step: an AI-edit call with `pullFromSource: true` that reads the source page's current content, translates it, and applies it as a normal vibe edit (see the landing-page ai-edit tools).",
      "Fails with 400 if `:slug` is already a translation (not the group's source) — a variant must always be created from the group's actual source page. Fails with 409 if a variant in this language already exists in the group (check get_landing_page_translations first).",
    ].join(" "),
    {
      slug: z.string().describe("Source landing page slug — the page to create a language variant of"),
      language: z
        .enum(SUPPORTED_LANGUAGE_CODES)
        .describe(
          `Language of the new variant, as a BCP-47 code. One of: ${LANGUAGE_CODE_LIST_TEXT}. Must differ from the source page's own language.`
        ),
    },
    async ({ slug, language }) => {
      const data = await api.post<unknown>(`/api/agent/v1/landing-pages/${slug}/translations`, { language });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
