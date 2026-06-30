/**
 * Landing pages + side pages tools.
 *
 * All tools wrap /api/agent/v1/landing-pages/* and /api/agent/v1/brands/{id}/landing-pages
 * as mapped in docs/43-agentic/08-update-mcp/00-reqs.md §3.1.
 *
 * Async ops (generate, vibe-edit, side-page generate) return { operationId }
 * — use get_job to poll them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, pick } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

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

interface VibeEditStatus {
  state?: string;
  progress?: number | string;
  result?: unknown;
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
    "Update the title or instructions of a landing page. For AI-powered edits, use vibe_edit_landing_page.",
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

  // ── Set landing page content (manual write) ───────────────────────────────
  server.tool(
    "set_landing_page",
    [
      "Overwrite the content and/or metadata of a landing page.",
      "Pass content as a string (HTML or markdown). Pass metadata as a JSON object.",
      "Returns a versionId — all writes are versioned.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("Full page content (HTML or markdown)"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata object"),
    },
    async ({ slug, title, content, metadata }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (metadata !== undefined) body.metadata = metadata;
      const data = await api.put<Record<string, unknown>>(`/api/agent/v1/landing-pages/${slug}/content`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Regenerate landing page ───────────────────────────────────────────────
  server.tool(
    "regenerate_landing_page",
    [
      "Re-generate a landing page's content using AI. Optionally restrict to specific sections.",
      "Returns an operationId — poll with get_job to track progress.",
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
      "Use AI to edit a landing page based on natural-language instructions.",
      "Returns an operationId — poll with get_vibe_edit_status or get_job until status is 'completed'.",
      "Optionally limit to a specific scope ('headline' | 'cta' | 'full') or a single sectionId.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      instructions: z
        .string()
        .describe("Natural-language edit instructions, e.g. 'Make the CTA more urgent'"),
      scope: z
        .enum(["headline", "cta", "full"])
        .optional()
        .describe("Restrict edits to a specific section type"),
      sectionId: z.string().optional().describe("Specific section ID to edit"),
    },
    async ({ slug, instructions, scope, sectionId }) => {
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
    "Poll vibe (AI) edit status. detail='full' (default) includes the result payload; 'short'/'medium' return just state+progress.",
    {
      slug: z.string().describe("Landing page slug"),
      operationId: z.string().describe("Operation ID from vibe_edit_landing_page"),
      detail: detailParam("full"),
    },
    async ({ slug, operationId, detail }) => {
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/landing-pages/${slug}/ai-edit/status/${operationId}`
      );
      const p = raw as VibeEditStatus;
      const proj = {
        short: (row: VibeEditStatus) => pick(row, ["state", "progress"]),
        medium: (row: VibeEditStatus) => pick(row, ["state", "progress"]),
      };
      const text = JSON.stringify(project(detail, p, proj));
      return { content: [{ type: "text" as const, text }] };
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
