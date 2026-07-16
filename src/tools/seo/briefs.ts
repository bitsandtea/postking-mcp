import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { detailParam, project, projectList, type Projector } from "../../detail.js";
import { brandDashboardUrl } from "../../links.js";
import { etaFor } from "../../etas.js";

/**
 * SEO / GEO flow — brief review/approval, custom (one-off) brief creation, and
 * the manual article-write fallback path.
 *
 * Step 7 of the canonical flow (see prompts.ts `seo_end_to_end` for the source
 * of truth): review & approve briefs → write. See src/tools/seo/index.ts for the
 * full flow doc comment.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface CompactBrief {
  id: string;
  type: string;
  status: string;
  roadmapItemId: string | null;
  title: string | null;
  clusterId: string | null;
  clusterName: string | null;
  briefSummary: string | null;
  sidePageUrl: string | null;
  generationError: string | null;
  blogArticleId: string | null;
  generatedAt: string | null;
  approvedAt: string | null;
}

function projectBrief(b: Record<string, unknown>): CompactBrief {
  const roadmapItem = b.roadmapItem != null && typeof b.roadmapItem === "object"
    ? (b.roadmapItem as Record<string, unknown>)
    : null;
  const cluster = b.cluster != null && typeof b.cluster === "object"
    ? (b.cluster as Record<string, unknown>)
    : null;
  const briefData = b.briefData != null && typeof b.briefData === "object"
    ? (b.briefData as Record<string, unknown>)
    : null;

  let briefSummary: string | null = null;
  if (briefData) {
    const bdTitle = briefData.title != null ? String(briefData.title) : null;
    const sections = Array.isArray(briefData.sections)
      ? briefData.sections
      : Array.isArray(briefData.h2s)
      ? briefData.h2s
      : null;
    const h2Count = sections ? sections.length : null;
    if (bdTitle && h2Count != null) {
      briefSummary = `${bdTitle} (${h2Count} sections)`;
    } else if (bdTitle) {
      briefSummary = bdTitle;
    } else {
      briefSummary = "outline present";
    }
  }

  return {
    id: String(b.id ?? ""),
    type: String(b.type ?? ""),
    status: String(b.status ?? ""),
    roadmapItemId: b.roadmapItemId != null ? String(b.roadmapItemId) : null,
    title: roadmapItem?.title != null ? String(roadmapItem.title) : null,
    clusterId: cluster?.id != null ? String(cluster.id) : null,
    clusterName: cluster?.name != null ? String(cluster.name) : null,
    briefSummary,
    sidePageUrl: b.sidePageUrl != null ? String(b.sidePageUrl) : null,
    generationError: b.generationError != null ? String(b.generationError) : null,
    blogArticleId: b.blogArticleId != null ? String(b.blogArticleId) : null,
    generatedAt: b.generatedAt != null ? String(b.generatedAt) : null,
    approvedAt: b.approvedAt != null ? String(b.approvedAt) : null,
  };
}

const briefListProj: Projector<Record<string, unknown>> = {
  short: (b) => {
    const roadmapItem = b.roadmapItem != null && typeof b.roadmapItem === "object"
      ? (b.roadmapItem as Record<string, unknown>)
      : null;
    return {
      id: String(b.id ?? ""),
      type: String(b.type ?? ""),
      status: String(b.status ?? ""),
      title: roadmapItem?.title != null ? String(roadmapItem.title) : null,
    };
  },
  medium: projectBrief,
};

const getBriefProj: Projector<Record<string, unknown>> = {
  short: (b) => ({
    id: String(b.id ?? ""),
    type: String(b.type ?? ""),
    status: String(b.status ?? ""),
  }),
  medium: (b) => {
    const roadmapItem = b.roadmapItem != null && typeof b.roadmapItem === "object"
      ? (b.roadmapItem as Record<string, unknown>)
      : null;
    const cluster = b.cluster != null && typeof b.cluster === "object"
      ? (b.cluster as Record<string, unknown>)
      : null;
    const briefData = b.briefData != null && typeof b.briefData === "object"
      ? (b.briefData as Record<string, unknown>)
      : null;
    let briefSummary: string | null = null;
    if (briefData) {
      const bdTitle = briefData.title != null ? String(briefData.title) : null;
      const sections = Array.isArray(briefData.sections) ? briefData.sections
        : Array.isArray(briefData.h2s) ? briefData.h2s
        : null;
      const h2Count = sections ? sections.length : null;
      if (bdTitle && h2Count != null) {
        briefSummary = `${bdTitle} (${h2Count} sections)`;
      } else if (bdTitle) {
        briefSummary = bdTitle;
      } else {
        briefSummary = "outline present";
      }
    }
    return {
      id: String(b.id ?? ""),
      type: String(b.type ?? ""),
      status: String(b.status ?? ""),
      title: roadmapItem?.title != null ? String(roadmapItem.title) : null,
      clusterName: cluster?.name != null ? String(cluster.name) : null,
      briefSummary,
      sidePageUrl: b.sidePageUrl != null ? String(b.sidePageUrl) : null,
    };
  },
};

export function registerSeoBriefTools(server: McpServer) {
  // ── 6b. List briefs ───────────────────────────────────────────────────────
  server.tool(
    "seo_list_briefs",
    [
      "Returns ALL briefs across EVERY status by default — do NOT add a status filter unless the user explicitly asks. `statusBreakdown` gives the per-status counts (match these to the dashboard's brief count). NOTE: briefs whose generation is still in-flight may not appear here yet — check `list_operations` / `get_job` for in-progress generation.",
      "Returns short detail by default: {id, type, status, title} per brief.",
      "Use detail=\"medium\" for compact summary (clusterId, clusterName, briefSummary, sidePageUrl, generationError, blogArticleId, generatedAt, approvedAt) or detail=\"full\" for raw briefs including briefData outline.",
      "To inspect a single brief's full outline, call seo_get_brief with detail=\"full\".",
      "Filters: status (CSV — e.g. 'pending_review,approved'), type (CSV — e.g. 'blog,comparison,landing'), clusterId, roadmapItemId, q (cluster-name fuzzy match), limit (default 50, max 200), cursor.",
      "Response shape: { count, total, nextCursor, statusBreakdown, detail, briefs: [...] }.",
    ].join(" "),
    {
      status: z
        .string()
        .optional()
        .describe("CSV of statuses: pending_review | approved | rejected | writing | drafted | published | failed | needs_human_review"),
      type: z
        .string()
        .optional()
        .describe("CSV of brief types: blog | comparison | tool | landing"),
      clusterId: z.string().optional().describe("Filter to briefs under one cluster"),
      roadmapItemId: z.string().optional().describe("Filter to briefs for a single roadmap item"),
      q: z.string().optional().describe("Fuzzy match on cluster name"),
      limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous page"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ status, type, clusterId, roadmapItemId, q, limit, cursor, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      if (clusterId) qs.set("clusterId", clusterId);
      if (roadmapItemId) qs.set("roadmapItemId", roadmapItemId);
      if (q) qs.set("q", q);
      if (limit !== undefined) qs.set("limit", String(limit));
      if (cursor) qs.set("cursor", cursor);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs${suffix}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawBriefs = Array.isArray(raw.briefs) ? raw.briefs : [];
      const rows = rawBriefs.filter((b): b is Record<string, unknown> => b != null && typeof b === "object");
      const briefs = projectList(detail, rows, briefListProj);

      // statusBreakdown over the returned rows
      const statusBreakdown: Record<string, number> = {};
      for (const b of rows) {
        const s = typeof b.status === "string" ? b.status : "unknown";
        statusBreakdown[s] = (statusBreakdown[s] ?? 0) + 1;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: rows.length,
            total: raw.total ?? null,
            nextCursor: raw.nextCursor ?? null,
            statusBreakdown,
            detail,
            briefs,
            dashboardUrl: brandDashboardUrl(id, "seo_briefs"),
          }),
        }],
      };
    }
  );

  // ── 6c. Get one brief ─────────────────────────────────────────────────────
  server.tool(
    "seo_get_brief",
    [
      "Fetch a single SeoBrief by id, including its briefData outline, status, roadmap item, and cluster.",
      "Returns full detail by default (complete brief incl briefData). Use detail=\"medium\" for {id, type, status, title, clusterName, briefSummary, sidePageUrl} or detail=\"short\" for {id, type, status}.",
      "Use to inspect a brief before refining it with seo_edit_brief or approving it with seo_approve_briefs.",
    ].join(" "),
    {
      briefId: z.string().describe("Brief ID from seo_list_briefs"),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ briefId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/${briefId}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {} as Record<string, unknown>;
      const result = project(detail, raw, getBriefProj);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Create a single custom brief (generate-one) ───────────────────────────
  server.tool(
    "seo_create_custom_brief",
    (() => {
      const eta = etaFor("seo_brief_generate");
      return [
        "Create a single custom SEO brief on demand — the MCP entry point for the 'generate-one' custom-brief flow (previously only reachable via raw agent-v1 REST).",
        "Pass `clusterId` (from seo_create_cluster or seo_list_clusters) to add this brief into an EXISTING named cluster. Omit `clusterId` to fall back to the legacy behavior: a throwaway single-brief cluster is minted automatically (tagged origin=\"manual\").",
        "Async — returns `{ operationId, status }`. Poll get_job with the operationId until state is 'completed' (or 'failed'/'partially_failed'/'cancelled' on error), then call seo_get_brief with the briefId from the completed operation's result to read the generated outline.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      pillarKeyword: z.string().min(1).describe("Primary keyword/topic this brief targets"),
      supportingKeywords: z
        .array(z.string().min(1))
        .optional()
        .describe("Additional supporting keywords to weave into the brief (default: none)"),
      type: z.enum(["blog", "comparison", "tool", "landing"]).describe("Brief type"),
      intent: z.string().optional().describe("Optional search-intent hint for the writer"),
      research: z
        .object({
          grounded: z.boolean().optional().describe("Whether to ground the brief in live research"),
          tier: z.enum(["hub", "spoke", "side_page"]).optional().describe("Content tier for grounding depth"),
        })
        .optional()
        .describe("Optional research/grounding configuration"),
      selectedCompetitors: z
        .array(
          z.object({
            competitorId: z.string().describe("Competitor ID"),
            name: z.string().describe("Competitor name"),
            domain: z.string().describe("Competitor domain"),
          })
        )
        .optional()
        .describe("Competitors to ground the brief against"),
      clusterId: z
        .string()
        .optional()
        .describe("Existing KeywordCluster ID (from seo_create_cluster / seo_list_clusters) to add this brief into. Omit for the legacy throwaway-cluster behavior."),
      brandId: brandOpt,
    },
    async ({ pillarKeyword, supportingKeywords, type, intent, research, selectedCompetitors, clusterId, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {
        pillarKeyword,
        supportingKeywords: supportingKeywords ?? [],
        type,
      };
      if (intent !== undefined) body.intent = intent;
      if (research !== undefined) body.research = research;
      if (selectedCompetitors !== undefined) body.selectedCompetitors = selectedCompetitors;
      if (clusterId !== undefined) body.clusterId = clusterId;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/generate-one`,
        body
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...raw,
            note: "Async brief generation started. Poll get_job(operationId) until state is 'completed' (or 'failed'/'partially_failed'/'cancelled'), then call seo_get_brief with the resulting briefId.",
          }),
        }],
      };
    }
  );

  // ── 6d. Edit a brief ──────────────────────────────────────────────────────
  server.tool(
    "seo_edit_brief",
    [
      "Edit an SeoBrief before approval. The inner route does NOT accept free-text 'instructions' — refinement is structured.",
      "Pass `briefData` (the full replacement JSON for the brief outline — H2s, FAQs, keyword targets, etc.) and/or `status` ('approved' | 'rejected').",
      "Approving via this tool fires L4 article/comparison generation immediately and returns { brief, operationId } — prefer seo_approve_briefs for the canonical approval step.",
      "Typical refinement loop: seo_get_brief → mutate briefData locally → seo_edit_brief with the new briefData (status omitted) → seo_approve_briefs.",
    ].join(" "),
    {
      briefId: z.string().describe("Brief ID from seo_list_briefs"),
      briefData: z
        .unknown()
        .optional()
        .describe("Full structured replacement for the brief outline (object). Pulled from seo_get_brief, edited, sent back."),
      status: z
        .enum(["approved", "rejected"])
        .optional()
        .describe("Flip to 'approved' (fires generation) or 'rejected'. Omit to update briefData without changing status."),
      generateHeroImage: z
        .boolean()
        .optional()
        .describe(
          "When approving, also generate a hero image (extra credits). Article-type briefs only — comparison/landing-type briefs return a 400 if this is set."
        ),
      voiceProfileId: z
        .string()
        .optional()
        .describe("When approving, write in this voice profile."),
      attachedAssetId: z
        .string()
        .optional()
        .describe("When approving, attach an existing asset to the article."),
      parentSource: z
        .enum(["current", "published"])
        .optional()
        .describe("Landing-brief approval: which parent LP draft to extend from."),
      brandId: brandOpt,
    },
    async ({ briefId, briefData, status, generateHeroImage, voiceProfileId, attachedAssetId, parentSource, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (briefData !== undefined) body.briefData = briefData;
      if (status !== undefined) body.status = status;
      if (generateHeroImage !== undefined) body.generateHeroImage = generateHeroImage;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;
      if (attachedAssetId !== undefined) body.attachedAssetId = attachedAssetId;
      if (parentSource !== undefined) body.parentSource = parentSource;
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/${briefId}`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6e. Approve briefs ────────────────────────────────────────────────────
  server.tool(
    "seo_approve_briefs",
    [
      "Approves one or more SeoBriefs and AUTO-fires L4 article/comparison generation immediately — do NOT call seo_write_article after this.",
      `Typically takes ${etaFor("seo_article_generate")}.`,
      "After approval, poll each returned operationId with get_job until state is `completed` (or `failed`/`partially_failed`/`cancelled` on error). A brief in status `writing` means generation is already in progress — poll the existing operation, do not re-submit.",
      "Body: briefIds (array, max 200).",
      "Response: { approved, failed: [{briefId, reason}], operationIds, operations: [{briefId, operationId, type}] }.",
    ].join(" "),
    {
      briefIds: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe("Brief IDs to approve (from seo_list_briefs)"),
      generateHeroImage: z
        .boolean()
        .optional()
        .describe("Also generate a hero image per blog brief (extra credits)."),
      brandId: brandOpt,
    },
    async ({ briefIds, generateHeroImage, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { briefIds };
      if (generateHeroImage !== undefined) body.generateHeroImage = generateHeroImage;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/bulk-approve`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6f. Regenerate a brief ────────────────────────────────────────────────
  server.tool(
    "seo_regenerate_brief",
    [
      "Re-runs L3 brief generation for a single brief (scoped to its cluster).",
      "Typically takes ~2–5 min.",
      "Async — returns `{operationId, status}`. Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error), then re-fetch with seo_get_brief to see the refreshed briefData.",
      "Use when the existing brief's outline is unusable and a structured seo_edit_brief won't recover it.",
    ].join(" "),
    {
      briefId: z.string().describe("Brief ID from seo_list_briefs"),
      brandId: brandOpt,
    },
    async ({ briefId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/${briefId}/regenerate`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 7. Write article ──────────────────────────────────────────────────────
  server.tool(
    "seo_write_article",
    [
      "ALTERNATIVE write path — only call this when a brief was NOT approved via seo_approve_briefs (which already auto-generates). If the brief status is `writing`, generation is already in progress — poll the existing operationId with get_job until state is `completed` rather than calling this again.",
      "Step 7 (manual path). Draft a full blog article for a roadmap item. Uses credits.",
      `Typically takes ${etaFor("seo_article_generate")}.`,
      "Precondition: the brief for this roadmap item must be in status `approved`. If the brief is still `drafted` or `pending_review`, review with `seo_list_briefs` / `seo_get_brief`, refine with `seo_edit_brief`, then approve with `seo_approve_briefs` (which will auto-generate).",
      "Returns an articleId that can be reviewed, edited, or published.",
    ].join(" "),
    {
      roadmapItemId: z.string().describe("Roadmap item ID from seo_list_roadmap"),
      count: z.number().int().min(1).max(10).optional().default(1),
      voiceProfileId: z
        .string()
        .optional()
        .describe("Voice profile ID to write in a specific style"),
      brandId: brandOpt,
    },
    async ({ roadmapItemId, count, voiceProfileId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/${roadmapItemId}/write`,
        { count, voiceProfileId }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
