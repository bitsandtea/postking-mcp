import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

/**
 * SEO end-to-end agentic flow.
 *
 * Every tool here is a one-call wrapper around the /api/agent/v1/brands/{id}/seo/*
 * endpoints shipped by Team B. No business logic lives here — the agent flow is
 * composed by the LLM using the tool descriptions below as its playbook.
 *
 * Canonical flow (see prompts.ts `seo_end_to_end` for the source of truth):
 *   1. Seed              → seo_add_seeds
 *   2. Expand            → seo_generate_keywords (async — poll via get_job)
 *   3. Categorize        → seo_categorize
 *   4. Cluster           → seo_generate_clusters (async — poll via get_job)
 *   5. Approve clusters  → seo_bulk_approve_clusters / seo_approve_cluster
 *   6. Roadmap           → seo_generate_roadmap
 *   7. Review & approve briefs → seo_list_briefs → seo_edit_brief → seo_approve_briefs
 *   8. Write             → seo_write_article
 *   9. Audit & Publish   → seo_gap + seo_competitor + seo_publish_article + seo_roadmap_stats
 *
 * Steps 5 and 7 are explicit human-in-the-loop approval gates.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

export function registerSeoTools(server: McpServer) {
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
      "Uses credits. Returns `{operationId, status}` — Poll `get_job` with the operationId until `state` is `succeeded`.",
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
    "List generated keywords for the brand. Useful for auditing between steps.",
    {
      limit: z.number().int().min(1).max(500).optional().default(100),
      brandId: brandOpt,
    },
    async ({ limit, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords?limit=${limit}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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

  // ── 4. Generate clusters (async) ──────────────────────────────────────────
  server.tool(
    "seo_generate_clusters",
    [
      "Step 4 of the SEO / GEO flow — async cluster-generation step. Groups related keywords into topic clusters that become candidate pillar topics.",
      "Returns `{operationId, status}` — Poll `get_job` with the operationId until `state` is `succeeded`.",
      "After completion, call seo_list_clusters to pick a target, then seo_generate_roadmap.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/generate`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5. List clusters ──────────────────────────────────────────────────────
  server.tool(
    "seo_list_clusters",
    "Step 5. List clusters so the agent can pick one (or several) to approve before brief and roadmap generation.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5b. Bulk approve clusters (recommended path) ──────────────────────────
  server.tool(
    "seo_bulk_approve_clusters",
    [
      "Step 5b — bulk-approve N clusters in one call. Recommended path when an agent wants to move multiple clusters forward.",
      "Approving a cluster fires an async seo_brief_generate Operation per cluster; brief generation only runs on approved clusters.",
      "Response includes `operations: [{ clusterId, operationId }]` and `operationIds: string[]` — Poll `get_job` with the operationId until `state` is `succeeded`.",
    ].join(" "),
    {
      clusterIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Cluster IDs from seo_list_clusters to approve"),
      brandId: brandOpt,
    },
    async ({ clusterIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/bulk-approve`,
        { clusterIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5c. Approve a single cluster ──────────────────────────────────────────
  server.tool(
    "seo_approve_cluster",
    [
      "Approve a single cluster. Gates brief generation — only approved clusters get briefs drafted.",
      "Position in flow: after seo_generate_clusters + seo_list_clusters, before seo_generate_roadmap / brief review.",
      "Returns `{ cluster, operationId }` — the operationId is for the async brief-generation job kicked off by approval. Poll `get_job` with the operationId until `state` is `succeeded`.",
    ].join(" "),
    {
      clusterId: z.string().min(1).describe("Cluster ID from seo_list_clusters"),
      brandId: brandOpt,
    },
    async ({ clusterId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/${clusterId}/approve`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5d. Reject single cluster ─────────────────────────────────────────────
  server.tool(
    "seo_reject_cluster",
    "Reject a single cluster — marks it rejected and detaches its scored keywords. Use when a generated cluster isn't relevant.",
    {
      clusterId: z.string().min(1).describe("Cluster ID from seo_list_clusters"),
      brandId: brandOpt,
    },
    async ({ clusterId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/${clusterId}/reject`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5e. Bulk reject clusters ──────────────────────────────────────────────
  server.tool(
    "seo_bulk_reject_clusters",
    "Bulk-reject N clusters in one call. Symmetric to seo_bulk_approve_clusters.",
    {
      clusterIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Cluster IDs from seo_list_clusters to reject"),
      brandId: brandOpt,
    },
    async ({ clusterIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/bulk-reject`,
        { clusterIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5f. Unapprove a cluster ───────────────────────────────────────────────
  server.tool(
    "seo_unapprove_cluster",
    "Revert an approved cluster back to pending_review. Fails if briefs have already been generated for this cluster (cannot be reverted once briefs exist).",
    {
      clusterId: z.string().min(1).describe("Cluster ID to unapprove"),
      brandId: brandOpt,
    },
    async ({ clusterId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/${clusterId}/unapprove`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5g. Restore a rejected cluster ────────────────────────────────────────
  server.tool(
    "seo_restore_cluster",
    "Restore a rejected cluster back to pending_review so it can be approved again.",
    {
      clusterId: z.string().min(1).describe("Cluster ID to restore"),
      brandId: brandOpt,
    },
    async ({ clusterId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters/${clusterId}/restore`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6. Generate roadmap ───────────────────────────────────────────────────
  server.tool(
    "seo_generate_roadmap",
    [
      "Step 6. Turn one or more clusters into a prioritized content roadmap of blog articles to write.",
      "Pass `clusterId` (single) or `clusterIds` (array of cluster IDs from seo_list_clusters) — omit both to roadmap all clusters.",
      "After this, call seo_write_article.",
    ].join(" "),
    {
      clusterId: z
        .string()
        .optional()
        .describe("Single cluster ID from seo_list_clusters (convenience for one cluster)"),
      clusterIds: z
        .array(z.string())
        .optional()
        .describe("Array of cluster IDs from seo_list_clusters"),
      brandId: brandOpt,
    },
    async ({ clusterId, clusterIds, brandId }) => {
      const id = requireBrandId(brandId);
      const merged = [
        ...(clusterIds ?? []),
        ...(clusterId ? [clusterId] : []),
      ];
      const body: Record<string, unknown> = {};
      if (merged.length > 0) body.clusterIds = merged;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/generate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "seo_list_roadmap",
    "List roadmap items (blog topics queued for writing).",
    {
      status: z
        .enum(["suggested", "in_progress", "completed", "ignored"])
        .optional()
        .describe("Filter by status"),
      brandId: brandOpt,
    },
    async ({ status, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = status ? `?status=${status}` : "";
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap${qs}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6b. List briefs ───────────────────────────────────────────────────────
  server.tool(
    "seo_list_briefs",
    [
      "Step between roadmap generation and article writing. Lists the SeoBriefs generated for the brand's roadmap items.",
      "Each brief carries the H2/FAQ/keyword scaffolding that drives the final article — review them here, refine with seo_edit_brief, then approve with seo_approve_briefs before seo_write_article will run.",
      "Filters: status (CSV — e.g. 'pending_review,approved'), type (CSV — e.g. 'blog,comparison,landing'), clusterId, roadmapItemId, q (cluster-name fuzzy match), limit (default 50, max 200), cursor.",
      "Response shape: { briefs: SeoBrief[], nextCursor, total, webUrl }. Each brief includes id, status, type, briefData (the structured outline), roadmapItem, cluster.",
    ].join(" "),
    {
      status: z
        .string()
        .optional()
        .describe("CSV of statuses: draft | pending_review | approved | rejected | writing | published"),
      type: z
        .string()
        .optional()
        .describe("CSV of brief types: blog | comparison | landing"),
      clusterId: z.string().optional().describe("Filter to briefs under one cluster"),
      roadmapItemId: z.string().optional().describe("Filter to briefs for a single roadmap item"),
      q: z.string().optional().describe("Fuzzy match on cluster name"),
      limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous page"),
      brandId: brandOpt,
    },
    async ({ status, type, clusterId, roadmapItemId, q, limit, cursor, brandId }) => {
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
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6c. Get one brief ─────────────────────────────────────────────────────
  server.tool(
    "seo_get_brief",
    [
      "Fetch a single SeoBrief by id, including its briefData outline, status, roadmap item, and cluster.",
      "Use to inspect a brief before refining it with seo_edit_brief or approving it with seo_approve_briefs.",
    ].join(" "),
    {
      briefId: z.string().describe("Brief ID from seo_list_briefs"),
      brandId: brandOpt,
    },
    async ({ briefId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/briefs/${briefId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
        .describe("When approving, also generate a hero image (extra credits)."),
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
      "Approves one or more SeoBriefs so they become eligible for seo_write_article.",
      "Required gate before article generation — seo_write_article will reject a brief whose status is still `draft` or `pending_review`.",
      "Body: briefIds (array, max 200). Approval fires the L4 article/comparison generation for each brief and returns operationIds — poll get_job to follow each one.",
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
      "Async — returns `{operationId, status}`. Poll `get_job` with the operationId until `state` is `succeeded`, then re-fetch with seo_get_brief to see the refreshed briefData.",
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
      "Step 7. Draft a full blog article for a roadmap item. Uses credits.",
      "Precondition: the brief for this roadmap item must be approved (status `approved`). If the brief is still `draft` or `pending_review`, this call will fail — review with `seo_list_briefs` / `seo_get_brief`, refine with `seo_edit_brief`, then approve with `seo_approve_briefs`.",
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

  // ── 8. Gap analysis ──────────────────────────────────────────────────────
  server.tool(
    "seo_gap",
    "Identify content gaps — topics the brand's competitors cover but the brand doesn't. Returns a list of gap opportunities.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/gap-analysis`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 9. Competitor diff ────────────────────────────────────────────────────
  server.tool(
    "seo_competitor",
    "Compare the brand's keyword coverage against a competitor domain. Returns overlapping and unique keywords.",
    {
      competitorDomain: z.string().describe("Competitor domain, e.g. 'competitor.com'"),
      brandId: brandOpt,
    },
    async ({ competitorDomain, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/competitor-diff`,
        { competitorDomain }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Roadmap item — view ───────────────────────────────────────────────────
  server.tool(
    "seo_roadmap_get",
    "View a single roadmap item by ID. Returns the title, status, priority, and keyword.",
    {
      itemId: z.string().describe("Roadmap item ID from seo_list_roadmap"),
      brandId: brandOpt,
    },
    async ({ itemId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/${itemId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Roadmap item — edit ───────────────────────────────────────────────────
  server.tool(
    "seo_roadmap_edit",
    "Edit a roadmap item — update its title, status (suggested|in_progress|completed|ignored), or priority.",
    {
      itemId: z.string().describe("Roadmap item ID from seo_list_roadmap"),
      title: z.string().optional().describe("New title for the roadmap item"),
      status: z
        .enum(["suggested", "in_progress", "completed", "ignored"])
        .optional()
        .describe("New status"),
      priority: z.number().int().optional().describe("Priority integer (lower = higher priority)"),
      brandId: brandOpt,
    },
    async ({ itemId, title, status, priority, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/${itemId}`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Roadmap item — delete ─────────────────────────────────────────────────
  server.tool(
    "seo_roadmap_delete",
    "Permanently delete a roadmap item. Pass confirm: true to proceed — this is irreversible.",
    {
      itemId: z.string().describe("Roadmap item ID to delete"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
      brandId: brandOpt,
    },
    async ({ itemId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/${itemId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 10. Roadmap stats ─────────────────────────────────────────────────────
  server.tool(
    "seo_roadmap_stats",
    "Progress stats for the content roadmap (completed, in-progress, suggested counts).",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/stats`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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

  // ── 13. Generate a side page linked to an SEO cluster ─────────────────────
  server.tool(
    "seo_generate_side_page",
    [
      "Generates a side page for a brand's landing page, optionally linked to an SEO cluster (`clusterId`).",
      "When linked, the side page surfaces in cluster-context queries and inherits the cluster's keyword targeting — strengthening topical authority that feeds GEO citation patterns.",
      "Two body modes:",
      "  • freeform: pass `key` + `prompt` (+ optional `keywords`, `selectedSections`, `voiceProfileId`, `sidePageType`).",
      "  • brief: pass `key` + `brief` (structured outline) + optional `briefId` and `roadmapItemId`.",
      "Async — returns `{ success, operationId, operationRowId, pollUrl, sidePageId }`. Poll `get_job` with the operationId until `state` is `succeeded`; comparison-type briefs run synchronously and return `sidePageId` directly.",
      "`slug` is the PARENT landing page slug under which the side page is created.",
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
      clusterId: z
        .string()
        .optional()
        .describe("SEO KeywordCluster ID to link this side page to (maps to SidePage.sourceClusterId)"),
      briefId: z
        .string()
        .optional()
        .describe("Persisted SeoBrief ID — required for comparison-type generation"),
      roadmapItemId: z.string().optional().describe("Roadmap item ID this side page is fulfilling"),
    },
    async ({ slug, key, prompt, brief, keywords, sidePageType, voiceProfileId, autoAssignAssets, clusterId, briefId, roadmapItemId }) => {
      const body: Record<string, unknown> = { key };
      if (prompt !== undefined) body.prompt = prompt;
      if (brief !== undefined) body.brief = brief;
      if (keywords !== undefined) body.keywords = keywords;
      if (sidePageType !== undefined) body.sidePageType = sidePageType;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;
      if (autoAssignAssets !== undefined) body.autoAssignAssets = autoAssignAssets;
      if (clusterId !== undefined) body.clusterId = clusterId;
      if (briefId !== undefined) body.briefId = briefId;
      if (roadmapItemId !== undefined) body.roadmapItemId = roadmapItemId;
      const data = await api.post<unknown>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/generate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
