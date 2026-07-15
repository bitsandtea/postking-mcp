import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import {
  detailParam,
  project,
  projectList,
  truncate,
  type Projector,
} from "../detail.js";
import { brandDashboardUrl } from "../links.js";
import { etaFor } from "../etas.js";
import { config } from "../config.js";
import { derivedJobFields } from "./jobs.js";

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
 *   8. Write — seo_approve_briefs auto-fires article generation and returns operationIds; poll each with get_job until state is `completed`. (seo_write_article is only for (re)generating an article when approval was not used.)
 *   9. Audit & Publish   → seo_gap + seo_competitor + seo_publish_article + seo_roadmap_stats
 *
 * Steps 5 and 7 are explicit human-in-the-loop approval gates.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Compact projection helpers ──────────────────────────────────────────────

interface CompactCluster {
  id: string;
  name: string;
  pillarKeyword: string | null;
  status: string;
  briefGenerationStatus: string | null;
  briefCount: number;
  keywordCount: number;
  topKeywords: string[];
  firstBriefId: string | null;
  description: string | null;
}

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

interface CompactRoadmapItem {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  primaryKeywords: string[];
  clusterId: string | null;
}

function projectCluster(c: Record<string, unknown>): CompactCluster {
  const keywordsMeta = Array.isArray(c.keywordsMeta) ? c.keywordsMeta : [];
  const keywords = Array.isArray(c.keywords) ? c.keywords : [];
  const keywordCount = keywordsMeta.length > 0 ? keywordsMeta.length : keywords.length;
  const topKeywords = (keywords as unknown[]).slice(0, 8).filter((k): k is string => typeof k === "string");
  return {
    id: String(c.id ?? ""),
    name: String(c.name ?? ""),
    pillarKeyword: c.pillarKeyword != null ? String(c.pillarKeyword) : null,
    status: String(c.status ?? ""),
    briefGenerationStatus: c.briefGenerationStatus != null ? String(c.briefGenerationStatus) : null,
    briefCount: typeof c.briefCount === "number" ? c.briefCount : 0,
    keywordCount,
    topKeywords,
    firstBriefId: c.firstBriefId != null ? String(c.firstBriefId) : null,
    description: truncate(c.description, 200),
  };
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

function projectRoadmapItem(item: Record<string, unknown>): CompactRoadmapItem {
  const primaryKeywords = Array.isArray(item.primaryKeywords)
    ? (item.primaryKeywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 5)
    : [];
  return {
    id: String(item.id ?? ""),
    title: String(item.title ?? ""),
    status: String(item.status ?? ""),
    priority: typeof item.priority === "number" ? item.priority : null,
    primaryKeywords,
    clusterId: item.clusterId != null ? String(item.clusterId) : null,
  };
}

// ── Hoisted helper (used in seo_competitor) ──────────────────────────────────

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

// ── Module-level Projectors ───────────────────────────────────────────────────

const clusterProj: Projector<Record<string, unknown>> = {
  short: (c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), status: String(c.status ?? "") }),
  medium: projectCluster,
};

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

const keywordProj: Projector<Record<string, unknown>> = {
  short: (k) => ({
    id: String(k.id ?? ""),
    keyword: String(k.keyword ?? ""),
    intent: k.intent != null ? String(k.intent) : null,
  }),
  medium: projectKeyword,
};

const roadmapItemProj: Projector<Record<string, unknown>> = {
  short: (item) => ({ id: String(item.id ?? ""), title: String(item.title ?? ""), status: String(item.status ?? "") }),
  medium: projectRoadmapItem,
};

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

// GET-tool projectors (default: "full")

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

const getRoadmapItemProj: Projector<Record<string, unknown>> = {
  short: (item) => ({
    id: String(item.id ?? ""),
    title: String(item.title ?? ""),
    status: String(item.status ?? ""),
  }),
  medium: (item) => {
    const primaryKeywords = Array.isArray(item.primaryKeywords)
      ? (item.primaryKeywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 5)
      : [];
    return {
      id: String(item.id ?? ""),
      title: String(item.title ?? ""),
      status: String(item.status ?? ""),
      primaryKeywords,
      clusterId: item.clusterId != null ? String(item.clusterId) : null,
    };
  },
};

// ── End compact helpers ──────────────────────────────────────────────────────

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

  // ── 4. Generate clusters (async) ──────────────────────────────────────────
  server.tool(
    "seo_generate_clusters",
    [
      "Step 4 of the SEO / GEO flow — async cluster-generation step. Groups related keywords into topic clusters that become candidate pillar topics.",
      `Typically takes ${etaFor("seo_cluster_generate")}.`,
      "Returns `{operationId, status}` — Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error).",
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
    [
      "Step 5. List clusters so the agent can pick one (or several) to approve before brief and roadmap generation.",
      "Returns short detail by default: {id, name, status} per cluster.",
      "Use detail=\"medium\" for the full compact summary (pillarKeyword, briefGenerationStatus, briefCount, keywordCount, topKeywords, firstBriefId, description) or detail=\"full\" for raw cluster objects.",
      "Full keyword detail (keywordsMeta, contentMix, briefAssignments) is intentionally omitted at short/medium to keep context small — use cluster IDs with approve/reject tools directly.",
    ].join(" "),
    {
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawClusters = Array.isArray(raw.clusters) ? raw.clusters : [];
      const rows = rawClusters.filter((c): c is Record<string, unknown> => c != null && typeof c === "object");
      const clusters = projectList(detail, rows, clusterProj);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, detail, clusters }),
        }],
      };
    }
  );

  // ── 5b. Bulk approve clusters (recommended path) ──────────────────────────
  server.tool(
    "seo_bulk_approve_clusters",
    [
      "Step 5b — bulk-approve N clusters in one call. Recommended path when an agent wants to move multiple clusters forward.",
      "Approving a cluster fires an async seo_brief_generate Operation per cluster; brief generation only runs on approved clusters.",
      `Typically takes ${etaFor("seo_brief_generate")}.`,
      "Response includes `operations: [{ clusterId, operationId }]` and `operationIds: string[]` — Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error).",
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
      `Typically takes ${etaFor("seo_brief_generate")}.`,
      "Returns `{ cluster, operationId }` — the operationId is for the async brief-generation job kicked off by approval. Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error).",
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
    [
      "List roadmap items (blog topics queued for writing).",
      "Returns short detail by default: {id, title, status} per item.",
      "Use detail=\"medium\" for the compact summary (priority, primaryKeywords, clusterId) or detail=\"full\" for raw objects.",
      "Call seo_roadmap_get with detail=\"full\" for a single item's complete detail.",
    ].join(" "),
    {
      status: z
        .enum(["suggested", "in_progress", "completed", "ignored"])
        .optional()
        .describe("Filter by status"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ status, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = status ? `?status=${status}` : "";
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap${qs}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rawItems = Array.isArray(raw.items) ? raw.items
        : Array.isArray(raw.roadmapItems) ? raw.roadmapItems
        : Array.isArray(data) ? data
        : [];
      const rows = rawItems.filter((item): item is Record<string, unknown> => item != null && typeof item === "object");
      const items = projectList(detail, rows, roadmapItemProj);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, detail, items, dashboardUrl: brandDashboardUrl(id, "seo_briefs") }),
        }],
      };
    }
  );

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

  // ── Roadmap item — view ───────────────────────────────────────────────────
  server.tool(
    "seo_roadmap_get",
    [
      "View a single roadmap item by ID.",
      "Returns full detail by default (raw object). Use detail=\"medium\" for {id, title, status, primaryKeywords, clusterId} or detail=\"short\" for {id, title, status}.",
    ].join(" "),
    {
      itemId: z.string().describe("Roadmap item ID from seo_list_roadmap"),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ itemId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/${itemId}`
      );
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {} as Record<string, unknown>;
      const result = project(detail, raw, getRoadmapItemProj);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
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
      const dashboardUrl = brandDashboardUrl(id, "seo_briefs");
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...((data != null && typeof data === "object") ? data as Record<string, unknown> : { data }), dashboardUrl }, null, 2) }] };
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
      `Typically takes ${etaFor("landing_page_side_pages_generate")}.`,
      "Async — returns `{ success, operationId, operationRowId, pollUrl, sidePageId }`. Poll `get_job` with the operationId until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error); comparison-type briefs run synchronously and return `sidePageId` directly.",
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

  // ── Create a manual comparison page (no cluster / brief flow required) ─────
  server.tool(
    "create_comparison_page",
    [
      "Create a comparison / 'X vs Y' / 'best <category>' page for the brand WITHOUT going through the full SEO cluster → brief flow. One call kicks off generation and returns quickly with an operationId and a 'still_generating' or 'completed' status — it does NOT block until the page is fully built.",
      "`mode` controls the engine: 'research' crawls the named competitors + live SERP results before writing — slower (can take several minutes) but produces the strongest, best-grounded page; 'simple' skips all crawling and lets the LLM author from what you provide — fast, best when you already have the facts or just want a quick draft.",
      "When your inputs are sparse (few/no options, no domains, no seedData), prefer 'research' — it will discover and ground the comparison for you and yield a far stronger page than 'simple'.",
      "`seedData` (simple mode): paste your own raw facts/notes/competitor details here and the LLM writes from them instead of crawling — this is how you feed your own data and avoid a crawl.",
      "Async — fires the create, then waits only a short grace window before responding. On success returns { briefId, sidePageId, sidePageSlug, landingPageSlug, webUrl, warnings }. If it is still running past the grace window, returns { status: 'still_generating', operationId } — poll get_job with that operationId until state is 'completed'; do NOT fabricate the page yourself, and do NOT call create_comparison_page again for the same request while it's pending.",
      "Any `warnings` are surfaced verbatim — relay them to the user (e.g. sparse-input notes such as 'research mode would produce a stronger page').",
    ].join(" "),
    {
      mode: z
        .enum(["research", "simple"])
        .describe(
          "Generation engine. 'research' = crawl the competitors + live SERP, then write (slower, strongest, best for sparse inputs). 'simple' = no crawl, LLM authors from what you pass (fast; pair with seedData to feed your own facts)."
        ),
      primaryKeyword: z
        .string()
        .min(1)
        .describe(
          "The topic/keyword the page targets, e.g. \"Acme vs alternatives\", \"best CRM for startups\", \"Notion vs Obsidian\"."
        ),
      options: z
        .array(
          z.object({
            name: z.string().min(1).describe("Option / product / brand name"),
            domain: z.string().optional().describe("Option's website domain (helps research mode crawl it)"),
            isBrandOwn: z.boolean().optional().describe("True if this option is the user's own brand"),
          })
        )
        .optional()
        .describe("The things being compared. Omit to let research mode discover them."),
      pinnedCompetitor: z
        .object({
          name: z.string().min(1).describe("Competitor name"),
          domain: z.string().optional().describe("Competitor domain"),
        })
        .optional()
        .describe("A specific competitor to anchor a head-to-head comparison around."),
      preset: z
        .enum(["head_to_head", "alternatives_listicle", "category_roundup"])
        .optional()
        .describe("Page shape: head_to_head (X vs Y), alternatives_listicle (X vs alternatives), or category_roundup (best <category>). Inferred when omitted."),
      allowGenericRoundup: z
        .boolean()
        .optional()
        .describe("Allow a generic category roundup when no concrete options are supplied."),
      seedData: z
        .string()
        .optional()
        .describe("Simple-mode only: your own raw data/notes/facts about the options. When set, the LLM writes from this instead of crawling — feed it here to avoid a research crawl."),
      briefData: z
        .unknown()
        .optional()
        .describe("Advanced: a full pre-built structured comparison brief. When supplied, generation uses it directly and skips the LLM authoring step."),
      parentLandingPageSlug: z
        .string()
        .optional()
        .describe("Slug of the parent landing page to nest this comparison under. Defaults to the brand's primary landing page."),
      proposedSlug: z
        .string()
        .optional()
        .describe("Desired URL slug fragment for the new page (auto-generated from primaryKeyword if omitted)."),
      voiceProfileId: z.string().optional().describe("Voice profile ID to write the page in."),
      brandId: brandOpt,
    },
    async ({ mode, primaryKeyword, options, pinnedCompetitor, preset, allowGenericRoundup, seedData, briefData, parentLandingPageSlug, proposedSlug, voiceProfileId, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { mode, primaryKeyword };
      if (options !== undefined) body.options = options;
      if (pinnedCompetitor !== undefined) body.pinnedCompetitor = pinnedCompetitor;
      if (preset !== undefined) body.preset = preset;
      if (allowGenericRoundup !== undefined) body.allowGenericRoundup = allowGenericRoundup;
      if (seedData !== undefined) body.seedData = seedData;
      if (briefData !== undefined) body.briefData = briefData;
      if (parentLandingPageSlug !== undefined) body.parentLandingPageSlug = parentLandingPageSlug;
      if (proposedSlug !== undefined) body.proposedSlug = proposedSlug;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;

      const created = await api.post<{ operationId: string; status?: string; webUrl?: string }>(
        `/api/agent/v1/brands/${id}/comparison-pages`,
        body
      );
      const operationId = created.operationId;
      const webUrl = created.webUrl;

      // Comparison pages (especially research mode) can take minutes, so we
      // only wait up to generateGracePollMs (mirrors generate_post) before handing
      // the agent a "still running, keep polling" instruction instead of holding
      // the MCP request open — the remote gateway kills longer-blocking calls.
      // Terminal-state detection reuses derivedJobFields (the same helper
      // get_job uses against the operations endpoint).
      const maxAttempts = Math.ceil(config.generateGracePollMs / config.pollIntervalMs);
      let op: Record<string, unknown> = {};
      let timedOut = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
        op = await api.get<Record<string, unknown>>(
          `/api/agent/v1/brands/${id}/operations/${operationId}`
        );
        const { done, summary } = derivedJobFields(op);
        if (done) {
          if (String(op.state) !== "completed") {
            throw new Error(`Comparison page generation ${summary}`);
          }
          break;
        }
        if (attempt === maxAttempts - 1) timedOut = true;
      }

      if (timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "still_generating",
                operationId,
                ...(webUrl ? { webUrl } : {}),
                instruction:
                  "Generation is STILL RUNNING — it has NOT failed. Do NOT write or invent the comparison page yourself. Wait ~15s, then call get_job with this operationId (wait:true). Repeat until state is 'completed', then read the page details from the operation's result.",
              }),
            },
          ],
        };
      }

      const result = (op.result && typeof op.result === "object" ? op.result : {}) as Record<string, unknown>;
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
      const out: Record<string, unknown> = {
        status: "completed",
        briefId: result.briefId,
        sidePageId: result.sidePageId,
        sidePageSlug: result.sidePageSlug,
        landingPageSlug: result.landingPageSlug,
        ...(webUrl ? { webUrl } : {}),
        warnings,
      };
      if (warnings.length > 0) {
        out.note = `Generation completed with ${warnings.length} warning(s) — relay these to the user: ${warnings.join(" | ")}`;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out) }],
      };
    }
  );
}
