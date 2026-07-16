import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { detailParam, projectList, type Projector } from "../../detail.js";
import { brandDashboardUrl } from "../../links.js";

/**
 * SEO / GEO flow — generated results listing, gap/competitor audits, and
 * publish + post-publish CTA housekeeping.
 *
 * Steps 8–9 of the canonical flow (see prompts.ts `seo_end_to_end` for the
 * source of truth): audit & publish. See src/tools/seo/index.ts for the full
 * flow doc comment.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

function slimKeywordList(arr: unknown, cap = 50): { keywords: unknown[]; total: number } {
  if (!Array.isArray(arr)) return { keywords: [], total: 0 };
  const total = arr.length;
  const keywords = arr.slice(0, cap).map((k) => {
    if (typeof k === "string") return k;
    if (k != null && typeof k === "object") {
      const ko = k as Record<string, unknown>;
      return ko.keyword ?? ko.word ?? ko.text ?? ko;
    }
    return k;
  });
  return { keywords, total };
}

const gapProj: Projector<Record<string, unknown>> = {
  short: (g) => ({
    ...(g.id != null ? { id: String(g.id) } : {}),
    ...(g.topic != null ? { topic: String(g.topic) } : {}),
    ...(g.keyword != null ? { keyword: String(g.keyword) } : {}),
  }),
  medium: (g) => ({
    ...(g.id != null ? { id: String(g.id) } : {}),
    ...(g.topic != null ? { topic: String(g.topic) } : {}),
    ...(g.keyword != null ? { keyword: String(g.keyword) } : {}),
    ...(g.searchVolume != null ? { searchVolume: g.searchVolume } : {}),
    ...(g.volume != null ? { volume: g.volume } : {}),
    ...(g.difficulty != null ? { difficulty: g.difficulty } : {}),
    ...(Array.isArray(g.competitorDomains) ? { competitorDomains: g.competitorDomains } : {}),
  }),
};

export function registerSeoResultsTools(server: McpServer) {
  // ── 6e2. List SEO results ─────────────────────────────────────────────────
  server.tool(
    "seo_list_results",
    "List the 'Generated Results' (blog articles + side pages + comparisons) the SEO/GEO pipeline has produced — mirrors the dashboard Results tab. Includes BOTH draft and published items. Use kind to filter. This is the canonical 'what content has been generated' list — prefer it over reconstructing results from briefs.",
    {
      kind: z.enum(["all", "blog", "side_page", "comparison"]).optional().default("all").describe("Kind of result to filter by"),
      status: z.string().optional().describe("CSV of statuses to filter by"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Page size (default 50, max 200)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous page"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ kind, status, limit, cursor, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (kind && kind !== "all") qs.set("kind", kind);
      if (status) qs.set("status", status);
      if (limit !== undefined) qs.set("limit", String(limit));
      if (cursor) qs.set("cursor", cursor);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/results${suffix}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawResults = Array.isArray(raw.results) ? raw.results : [];
      const rows = rawResults.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");

      const resultsProj: Projector<Record<string, unknown>> = {
        short: (r) => ({
          id: String(r.id ?? ""),
          kind: String(r.kind ?? ""),
          title: r.title != null ? String(r.title) : null,
          status: String(r.status ?? ""),
        }),
        medium: (r) => ({
          id: String(r.id ?? ""),
          kind: String(r.kind ?? ""),
          title: r.title != null ? String(r.title) : null,
          status: String(r.status ?? ""),
          slug: r.slug != null ? String(r.slug) : null,
          clusterName: r.clusterName != null ? String(r.clusterName) : null,
          generatedAt: r.generatedAt != null ? String(r.generatedAt) : null,
        }),
      };

      const results = projectList(detail, rows, resultsProj);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: rows.length,
            total: raw.total ?? null,
            nextCursor: raw.nextCursor ?? null,
            detail,
            results,
            dashboardUrl: brandDashboardUrl(id, "seo_results"),
          }),
        }],
      };
    }
  );

  // ── 8. Gap analysis ──────────────────────────────────────────────────────
  server.tool(
    "seo_gap",
    [
      "Identify content gaps — topics the brand's competitors cover but the brand doesn't.",
      "Returns short detail by default: {id?, topic?, keyword?} labels only per gap.",
      "Use detail=\"medium\" for compact gaps (+ searchVolume, difficulty, competitorDomains) or detail=\"full\" for the raw API response.",
    ].join(" "),
    {
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/gap-analysis`
      );
      if (detail === "full") {
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawGaps = Array.isArray(raw.gaps) ? raw.gaps
        : Array.isArray(raw.opportunities) ? raw.opportunities
        : Array.isArray(data) ? data
        : null;
      if (rawGaps === null) {
        // Unknown shape — return as-is compactly
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
      const rows = rawGaps.filter((g): g is Record<string, unknown> => g != null && typeof g === "object");
      const gaps = projectList(detail, rows, gapProj);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, detail, gaps }),
        }],
      };
    }
  );

  // ── 9. Competitor diff ────────────────────────────────────────────────────
  server.tool(
    "seo_competitor",
    [
      "Compare the brand's keyword coverage against a competitor domain.",
      "Returns short detail by default: bucket totals only {overlapping: {total}, brandUnique: {total}, competitorOnly: {total}}.",
      "Use detail=\"medium\" for capped keyword lists (up to 50 per bucket) or detail=\"full\" for the raw API response.",
    ].join(" "),
    {
      competitorDomain: z.string().describe("Competitor domain, e.g. 'competitor.com'"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ competitorDomain, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/competitor-diff`,
        { competitorDomain }
      );
      if (detail === "full") {
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const overlapping = slimKeywordList(raw.overlapping ?? raw.overlap);
      const brandUnique = slimKeywordList(raw.brandOnly ?? raw.unique ?? raw.brandUnique);
      const competitorOnly = slimKeywordList(raw.competitorOnly ?? raw.competitorUnique);
      if (detail === "short") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              detail,
              overlapping: { total: overlapping.total },
              brandUnique: { total: brandUnique.total },
              competitorOnly: { total: competitorOnly.total },
            }),
          }],
        };
      }
      // medium
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ detail, overlapping, brandUnique, competitorOnly }),
        }],
      };
    }
  );

  // ── 11. Publish ───────────────────────────────────────────────────────────
  server.tool(
    "seo_publish_article",
    [
      "Step 10. Publish or schedule a roadmap-generated article to a publication.",
      "Free-tier choke point — may return FREE_CAP_REACHED with a checkoutUrl.",
    ].join(" "),
    {
      articleId: z.string().describe("Blog article ID"),
      publicationId: z.string().optional().describe("Target publication ID"),
      scheduledAt: z
        .string()
        .optional()
        .describe("ISO 8601 datetime to schedule; omit to publish now"),
      connectionIds: z
        .array(z.string())
        .optional()
        .describe("External publishing-connection IDs (WordPress, Medium, ...)"),
      brandId: brandOpt,
    },
    async ({ articleId, publicationId, scheduledAt, connectionIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/blogs/${articleId}/publish`,
        { publicationId, scheduledAt, connectionIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 12. Auto-assign side-page CTAs to blog articles (post-publish) ────────
  server.tool(
    "seo_auto_assign_cta",
    [
      "Optional capstone step — runs AFTER blog articles are published.",
      "Auto-suggests a published side-page CTA for each blog article in the batch by matching the article's keywords (cluster + tags + title) against the brand's published side pages, then writes the result to BlogArticle.sidePageInfo (header + ctaText + ctaButtonText + ctaHref).",
      "Defaults are safe to re-run: skips blogs that already have a CTA (`overwriteExisting=false`) and skips Webflow-synced blogs (`skipWebflowSynced=true`) since CTA edits don't push back to Webflow.",
      "Synchronous — returns `{ updated, skipped, errors, total, results: [{blogId, status, sidePageId?, sidePageSlug?}] }` directly; no polling needed.",
      "Pass `blogIds: \"all\"` to process every blog for the brand, or a list of up to 50 blog IDs.",
      "Hard cap of 50 blogs per call. For brands with more uncovered blogs, batch your `blogIds` arrays in groups of 50.",
      "The matcher uses keywords today; reusing an existing CTA header/ctaText body as a matching signal is a planned enhancement.",
    ].join(" "),
    {
      blogIds: z
        .union([
          z.array(z.string().min(1)).min(1).max(50),
          z.literal("all"),
        ])
        .describe("Blog article IDs to process, or the literal \"all\" for every blog in the brand"),
      overwriteExisting: z
        .boolean()
        .optional()
        .describe("Overwrite blogs that already have a sidePageInfo CTA (default false)"),
      skipWebflowSynced: z
        .boolean()
        .optional()
        .describe("Skip blogs with externalProvider=webflow (default true)"),
      brandId: brandOpt,
    },
    async ({ blogIds, overwriteExisting, skipWebflowSynced, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { blogIds };
      if (overwriteExisting !== undefined) body.overwriteExisting = overwriteExisting;
      if (skipWebflowSynced !== undefined) body.skipWebflowSynced = skipWebflowSynced;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/auto-assign-cta`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
