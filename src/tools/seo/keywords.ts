import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { detailParam, projectList, type Projector } from "../../detail.js";
import { etaFor } from "../../etas.js";

/**
 * SEO / GEO flow — seed keywords, expansion, categorization.
 *
 * Steps 1–3 of the canonical flow (see prompts.ts `seo_end_to_end` for the source
 * of truth): seed → expand → categorize. See src/tools/seo/index.ts for the full
 * flow doc comment.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface CompactKeyword {
  id: string;
  keyword: string;
  intent: string | null;
  priority: number | null;
  excludedFromClustering: boolean;
  userTags: string[];
  searchVolume: number | null;
  difficulty: number | null;
  relevance: number | null;
  clusterId: string | null;
}

// NOTE: the SeoScoredKeyword / API wire field names are `volume` and `kd`
// (see prisma/schema.prisma model SeoScoredKeyword in the main app) — there
// is no `searchVolume` or `difficulty` field on the wire. This projector
// reads the real field names and just relabels them for a friendlier tool
// output; do not reintroduce `k.searchVolume` / `k.difficulty` reads.
function projectKeyword(k: Record<string, unknown>): CompactKeyword {
  return {
    id: String(k.id ?? ""),
    keyword: String(k.keyword ?? ""),
    intent: k.intent != null ? String(k.intent) : null,
    priority: typeof k.priority === "number" ? k.priority : null,
    excludedFromClustering: Boolean(k.excludedFromClustering),
    userTags: Array.isArray(k.userTags) ? (k.userTags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    searchVolume: typeof k.volume === "number" ? k.volume : null,
    difficulty: typeof k.kd === "number" ? k.kd : null,
    relevance: typeof k.relevance === "number" ? k.relevance : null,
    clusterId: k.clusterId != null ? String(k.clusterId) : null,
  };
}

const keywordProj: Projector<Record<string, unknown>> = {
  short: (k) => ({
    id: String(k.id ?? ""),
    keyword: String(k.keyword ?? ""),
    intent: k.intent != null ? String(k.intent) : null,
  }),
  medium: projectKeyword,
};

export function registerSeoKeywordTools(server: McpServer) {
  // ── 1. Add seed keywords ──────────────────────────────────────────────────
  server.tool(
    "seo_add_seeds",
    [
      "Step 1 of the SEO / GEO flow. Add 3–10 seed keywords that describe what the brand wants to rank for.",
      "After this, call seo_generate_keywords to expand them into the full keyword universe.",
    ].join(" "),
    {
      seeds: z.array(z.string()).min(1).describe("Seed keywords or topics"),
      brandId: brandOpt,
    },
    async ({ seeds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/seeds`,
        { seeds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 2. Generate keywords ──────────────────────────────────────────────────
  server.tool(
    "seo_generate_keywords",
    [
      "Step 2 of the SEO / GEO flow. Async — expands seed keywords into the full keyword universe.",
      `Typically takes ${etaFor("seo_keyword_pull")}.`,
      "Uses credits. Returns `{operationId, status}` — Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error).",
      "The server picks the expansion size automatically; the only thing the agent can tweak is `autoScore` (defaults to true server-side — set false to skip volume/difficulty scoring).",
      "After completion, call seo_categorize.",
    ].join(" "),
    {
      autoScore: z
        .boolean()
        .optional()
        .describe("Whether to auto-score generated keywords (server default: true)"),
      brandId: brandOpt,
    },
    async ({ autoScore, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (autoScore !== undefined) body.autoScore = autoScore;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/generate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── list generated keywords (read-only) ───────────────────────────────────
  server.tool(
    "seo_list_keywords",
    [
      "List generated keywords for the brand. Useful for auditing between steps.",
      "Returns short detail by default: {id, keyword, intent} per keyword.",
      "Use detail=\"medium\" for the full compact summary (priority, searchVolume, difficulty, relevance, clusterId, excludedFromClustering, userTags) or detail=\"full\" for raw keyword objects.",
      "Supports server-side filtering: source, intent, clusterId, q (substring search), volumeMin/volumeMax, kdMin/kdMax, relevanceMin/relevanceMax, priorityMin/priorityMax, includeDeleted, excludedFromClustering.",
      "Use cursor (from a previous call's response) to page through results beyond limit.",
    ].join(" "),
    {
      limit: z.number().int().min(1).max(500).optional().default(100),
      cursor: z.string().optional().describe("Pagination cursor from a previous seo_list_keywords call"),
      source: z.string().optional().describe("CSV of keyword sources to filter by (e.g. \"seed,expanded\")"),
      intent: z
        .string()
        .optional()
        .describe("CSV of search-intent labels to filter by (informational, commercial, navigational, transactional)"),
      clusterId: z
        .string()
        .optional()
        .describe("Filter by cluster ID, or \"none\" for unclustered, or \"any\" for any clustered keyword"),
      q: z.string().optional().describe("Substring search over the keyword text"),
      volumeMin: z.number().int().min(0).optional().describe("Minimum search volume (inclusive)"),
      volumeMax: z.number().int().min(0).optional().describe("Maximum search volume (inclusive)"),
      kdMin: z.number().int().min(0).optional().describe("Minimum keyword difficulty (inclusive)"),
      kdMax: z.number().int().min(0).optional().describe("Maximum keyword difficulty (inclusive)"),
      relevanceMin: z.number().min(0).max(1).optional().describe("Minimum relevance score in [0,1] (inclusive)"),
      relevanceMax: z.number().min(0).max(1).optional().describe("Maximum relevance score in [0,1] (inclusive)"),
      priorityMin: z.number().min(0).max(1).optional().describe("Minimum priority score in [0,1] (inclusive)"),
      priorityMax: z.number().min(0).max(1).optional().describe("Maximum priority score in [0,1] (inclusive)"),
      includeDeleted: z.boolean().optional().describe("Include soft-deleted keywords (default: excluded)"),
      excludedFromClustering: z.boolean().optional().describe("Filter to keywords with this excludedFromClustering value"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({
      limit,
      cursor,
      source,
      intent,
      clusterId,
      q,
      volumeMin,
      volumeMax,
      kdMin,
      kdMax,
      relevanceMin,
      relevanceMax,
      priorityMin,
      priorityMax,
      includeDeleted,
      excludedFromClustering,
      detail,
      brandId,
    }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (cursor !== undefined) params.set("cursor", cursor);
      if (source !== undefined) params.set("source", source);
      if (intent !== undefined) params.set("intent", intent);
      if (clusterId !== undefined) params.set("clusterId", clusterId);
      if (q !== undefined) params.set("q", q);
      if (volumeMin !== undefined) params.set("volumeMin", String(volumeMin));
      if (volumeMax !== undefined) params.set("volumeMax", String(volumeMax));
      if (kdMin !== undefined) params.set("kdMin", String(kdMin));
      if (kdMax !== undefined) params.set("kdMax", String(kdMax));
      if (relevanceMin !== undefined) params.set("relevanceMin", String(relevanceMin));
      if (relevanceMax !== undefined) params.set("relevanceMax", String(relevanceMax));
      if (priorityMin !== undefined) params.set("priorityMin", String(priorityMin));
      if (priorityMax !== undefined) params.set("priorityMax", String(priorityMax));
      if (includeDeleted !== undefined) params.set("includeDeleted", String(includeDeleted));
      if (excludedFromClustering !== undefined) params.set("excludedFromClustering", String(excludedFromClustering));
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords?${params.toString()}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawKeywords = Array.isArray(raw.keywords) ? raw.keywords : Array.isArray(data) ? data : [];
      const rows = rawKeywords.filter((k): k is Record<string, unknown> => k != null && typeof k === "object");
      const keywords = projectList(detail, rows, keywordProj);
      const nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : null;
      const total = typeof raw.total === "number" ? raw.total : rows.length;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, total, nextCursor, detail, keywords }),
        }],
      };
    }
  );

  // ── Edit a keyword (housekeeping) ─────────────────────────────────────────
  server.tool(
    "seo_edit_keyword",
    [
      "Edit a single SeoScoredKeyword. Housekeeping op — not part of the main flow.",
      "At least one of `intent`, `userTags`, `priority`, or `excludedFromClustering` must be supplied.",
      "Use to override the auto-detected intent label, attach user tags, manually nudge priority (0..1), or exclude a noisy keyword from clustering.",
      'Example: {"keywordId":"kw_123","intent":"commercial","userTags":["enterprise"]}.',
    ].join(" "),
    {
      keywordId: z.string().min(1).describe("Keyword ID from seo_list_keywords"),
      intent: z
        .enum(["informational", "commercial", "navigational", "transactional"])
        .optional()
        .describe("Override the auto-detected search-intent label"),
      userTags: z
        .array(z.string())
        .optional()
        .describe("Replacement array of user tags (overwrites existing tags)"),
      priority: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Manual priority override in [0,1]"),
      excludedFromClustering: z
        .boolean()
        .optional()
        .describe("When true, the keyword is held out of the next clustering pass"),
      brandId: brandOpt,
    },
    async ({ keywordId, intent, userTags, priority, excludedFromClustering, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (intent !== undefined) body.intent = intent;
      if (userTags !== undefined) body.userTags = userTags;
      if (priority !== undefined) body.priority = priority;
      if (excludedFromClustering !== undefined) body.excludedFromClustering = excludedFromClustering;
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/${keywordId}`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete a keyword (soft-delete, housekeeping) ──────────────────────────
  server.tool(
    "seo_delete_keyword",
    [
      "Soft-delete a single SeoScoredKeyword (sets deletedAt; the row stays in the DB but is filtered out of all queries).",
      "Housekeeping op — not part of the main flow. Pass `confirm: true` to proceed.",
      "Use for obvious junk keywords the auto-pipeline missed. Prefer seo_edit_keyword with excludedFromClustering=true when you only want to hold a keyword out of the next clustering pass.",
    ].join(" "),
    {
      keywordId: z.string().min(1).describe("Keyword ID from seo_list_keywords"),
      confirm: z.literal(true).describe("Must be true to confirm soft-delete"),
      brandId: brandOpt,
    },
    async ({ keywordId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/${keywordId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Bulk-delete keywords (soft-delete, housekeeping) ──────────────────────
  server.tool(
    "seo_bulk_delete_keywords",
    [
      "Soft-delete N SeoScoredKeyword rows in one call (sets deletedAt; rows stay in the DB but are filtered out of all queries).",
      "Housekeeping op — not part of the main flow. Pass `confirm: true` to proceed.",
      "Use to clear out a batch of junk/irrelevant keywords the auto-pipeline missed, e.g. after filtering seo_list_keywords by relevanceMax.",
    ].join(" "),
    {
      keywordIds: z.array(z.string().min(1)).min(1).describe("Keyword IDs from seo_list_keywords"),
      confirm: z.literal(true).describe("Must be true to confirm bulk soft-delete"),
      brandId: brandOpt,
    },
    async ({ keywordIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/bulk-delete`,
        { keywordIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Restore soft-deleted keywords (housekeeping) ──────────────────────────
  server.tool(
    "seo_restore_keyword",
    [
      "Undo a soft-delete: clears deletedAt on the given SeoScoredKeyword ids so they reappear in seo_list_keywords / seo_list_keyword_ids.",
      "Housekeeping op — not part of the main flow. Use after seo_delete_keyword or seo_bulk_delete_keywords removed something that shouldn't have been removed.",
      "IDs that are not currently soft-deleted are silently no-ops (the response's `restored` count only reflects rows that actually changed). Find deleted ids with seo_list_keyword_ids using includeDeleted=true.",
    ].join(" "),
    {
      keywordIds: z.array(z.string().min(1)).min(1).describe("Keyword IDs to restore (from seo_list_keyword_ids with includeDeleted=true)"),
      brandId: brandOpt,
    },
    async ({ keywordIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/restore`,
        { keywordIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Bulk-edit keywords (housekeeping) ─────────────────────────────────────
  server.tool(
    "seo_bulk_edit_keywords",
    [
      "Edit userTags, intent, priority, and/or excludedFromClustering across N SeoScoredKeyword rows in one call — the same values are applied to every id in `keywordIds`.",
      "Housekeeping op — not part of the main flow. Pass `confirm: true` to proceed (this can silently overwrite tags/intent/priority for many keywords at once).",
      "At least one of intent, userTags, priority, or excludedFromClustering must be supplied.",
      "Typical flow: call seo_list_keyword_ids with a filter to get the target ids, then pass them here.",
      'Example: {"keywordIds":["kw_1","kw_2"],"excludedFromClustering":true,"confirm":true}.',
    ].join(" "),
    {
      keywordIds: z.array(z.string().min(1)).min(1).describe("Keyword IDs from seo_list_keywords or seo_list_keyword_ids"),
      intent: z
        .enum(["informational", "commercial", "navigational", "transactional"])
        .optional()
        .describe("Override the auto-detected search-intent label for all listed keywords"),
      userTags: z
        .array(z.string())
        .optional()
        .describe("Replacement array of user tags applied to all listed keywords (overwrites existing tags)"),
      priority: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Manual priority override in [0,1] applied to all listed keywords"),
      excludedFromClustering: z
        .boolean()
        .optional()
        .describe("When true, holds all listed keywords out of the next clustering pass"),
      confirm: z.literal(true).describe("Must be true to confirm the bulk edit"),
      brandId: brandOpt,
    },
    async ({ keywordIds, intent, userTags, priority, excludedFromClustering, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { keywordIds };
      if (intent !== undefined) body.intent = intent;
      if (userTags !== undefined) body.userTags = userTags;
      if (priority !== undefined) body.priority = priority;
      if (excludedFromClustering !== undefined) body.excludedFromClustering = excludedFromClustering;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/bulk-update`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Filtered keyword-id export (housekeeping) ─────────────────────────────
  server.tool(
    "seo_list_keyword_ids",
    [
      "Return just the ids of every SeoScoredKeyword matching a filter — unpaginated, no keyword data attached. Housekeeping op — not part of the main flow.",
      "Accepts the same filter set as seo_list_keywords: source, intent, clusterId, q, volumeMin/volumeMax, kdMin/kdMax, relevanceMin/relevanceMax, priorityMin/priorityMax, includeDeleted, excludedFromClustering.",
      "Use to select \"all keywords matching filter X\" in one call, then feed the returned ids into seo_bulk_delete_keywords or seo_bulk_edit_keywords.",
      'Example: filter relevanceMax=0.2 to find low-relevance keywords, then bulk-delete or bulk-edit them.',
    ].join(" "),
    {
      source: z.string().optional().describe("CSV of keyword sources to filter by (e.g. \"seed,expanded\")"),
      intent: z
        .string()
        .optional()
        .describe("CSV of search-intent labels to filter by (informational, commercial, navigational, transactional)"),
      clusterId: z
        .string()
        .optional()
        .describe("Filter by cluster ID, or \"none\" for unclustered, or \"any\" for any clustered keyword"),
      q: z.string().optional().describe("Substring search over the keyword text"),
      volumeMin: z.number().int().min(0).optional().describe("Minimum search volume (inclusive)"),
      volumeMax: z.number().int().min(0).optional().describe("Maximum search volume (inclusive)"),
      kdMin: z.number().int().min(0).optional().describe("Minimum keyword difficulty (inclusive)"),
      kdMax: z.number().int().min(0).optional().describe("Maximum keyword difficulty (inclusive)"),
      relevanceMin: z.number().min(0).max(1).optional().describe("Minimum relevance score in [0,1] (inclusive)"),
      relevanceMax: z.number().min(0).max(1).optional().describe("Maximum relevance score in [0,1] (inclusive)"),
      priorityMin: z.number().min(0).max(1).optional().describe("Minimum priority score in [0,1] (inclusive)"),
      priorityMax: z.number().min(0).max(1).optional().describe("Maximum priority score in [0,1] (inclusive)"),
      includeDeleted: z.boolean().optional().describe("Include soft-deleted keywords (default: excluded)"),
      excludedFromClustering: z.boolean().optional().describe("Filter to keywords with this excludedFromClustering value"),
      brandId: brandOpt,
    },
    async ({
      source,
      intent,
      clusterId,
      q,
      volumeMin,
      volumeMax,
      kdMin,
      kdMax,
      relevanceMin,
      relevanceMax,
      priorityMin,
      priorityMax,
      includeDeleted,
      excludedFromClustering,
      brandId,
    }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (source !== undefined) params.set("source", source);
      if (intent !== undefined) params.set("intent", intent);
      if (clusterId !== undefined) params.set("clusterId", clusterId);
      if (q !== undefined) params.set("q", q);
      if (volumeMin !== undefined) params.set("volumeMin", String(volumeMin));
      if (volumeMax !== undefined) params.set("volumeMax", String(volumeMax));
      if (kdMin !== undefined) params.set("kdMin", String(kdMin));
      if (kdMax !== undefined) params.set("kdMax", String(kdMax));
      if (relevanceMin !== undefined) params.set("relevanceMin", String(relevanceMin));
      if (relevanceMax !== undefined) params.set("relevanceMax", String(relevanceMax));
      if (priorityMin !== undefined) params.set("priorityMin", String(priorityMin));
      if (priorityMax !== undefined) params.set("priorityMax", String(priorityMax));
      if (includeDeleted !== undefined) params.set("includeDeleted", String(includeDeleted));
      if (excludedFromClustering !== undefined) params.set("excludedFromClustering", String(excludedFromClustering));
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/ids?${params.toString()}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const ids = Array.isArray(raw.ids) ? raw.ids : [];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: ids.length, ids }),
        }],
      };
    }
  );

  // ── 3. Categorize ─────────────────────────────────────────────────────────
  server.tool(
    "seo_categorize",
    [
      "Step 3 of the SEO / GEO flow. Tag keywords by search intent and/or user tags.",
      "Pass `updates`: an array of `{keywordId, intent?, userTags?}` (intent ∈ informational | commercial | navigational | transactional).",
      'Example: {"updates":[{"keywordId":"kw_123","intent":"commercial"}]}.',
      "After this, call seo_generate_clusters.",
    ].join(" "),
    {
      updates: z
        .array(
          z.object({
            keywordId: z.string().min(1).describe("Keyword ID from seo_list_keywords"),
            intent: z
              .enum(["informational", "commercial", "navigational", "transactional"])
              .optional()
              .describe("Search intent label"),
            userTags: z.array(z.string()).optional().describe("Optional user-supplied tags"),
          })
        )
        .min(1)
        .max(500)
        .describe("Per-keyword categorization updates"),
      brandId: brandOpt,
    },
    async ({ updates, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/categorize`,
        { updates }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
