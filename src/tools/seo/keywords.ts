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
}

function projectKeyword(k: Record<string, unknown>): CompactKeyword {
  return {
    id: String(k.id ?? ""),
    keyword: String(k.keyword ?? ""),
    intent: k.intent != null ? String(k.intent) : null,
    priority: typeof k.priority === "number" ? k.priority : null,
    excludedFromClustering: Boolean(k.excludedFromClustering),
    userTags: Array.isArray(k.userTags) ? (k.userTags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    searchVolume: typeof k.searchVolume === "number" ? k.searchVolume : null,
    difficulty: typeof k.difficulty === "number" ? k.difficulty : null,
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
      "Use detail=\"medium\" for the full compact summary (priority, searchVolume, difficulty, excludedFromClustering, userTags) or detail=\"full\" for raw keyword objects.",
    ].join(" "),
    {
      limit: z.number().int().min(1).max(500).optional().default(100),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords?limit=${limit}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawKeywords = Array.isArray(raw.keywords) ? raw.keywords : Array.isArray(data) ? data : [];
      const rows = rawKeywords.filter((k): k is Record<string, unknown> => k != null && typeof k === "object");
      const keywords = projectList(detail, rows, keywordProj);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, detail, keywords }),
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
