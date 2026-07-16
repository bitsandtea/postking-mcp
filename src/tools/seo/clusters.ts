import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { detailParam, truncate, projectList, type Projector } from "../../detail.js";
import { etaFor } from "../../etas.js";

/**
 * SEO / GEO flow — cluster generation, review, and manual cluster creation.
 *
 * Steps 4–5 of the canonical flow (see prompts.ts `seo_end_to_end` for the source
 * of truth): cluster → approve. See src/tools/seo/index.ts for the full flow doc
 * comment.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

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

const clusterProj: Projector<Record<string, unknown>> = {
  short: (c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), status: String(c.status ?? "") }),
  medium: projectCluster,
};

export function registerSeoClusterTools(server: McpServer) {
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

  // ── Create a manual cluster (no pipeline, no LLM) ─────────────────────────
  server.tool(
    "seo_create_cluster",
    [
      "Create a real, named SEO cluster by hand — bypasses the auto-clustering pipeline entirely (no LLM call). The cluster starts empty; use seo_create_custom_brief with the returned `id` as `clusterId` to add its first brief.",
      "Manual clusters are tagged `origin: \"manual\"` so the dashboard can distinguish them from pipeline-generated clusters, and are created already `approved` (no separate approval step needed).",
      "Cluster names must be unique per brand — if the name is already taken, this returns a clear `cluster_name_taken` error instead of creating a duplicate; pick a different name or reuse the existing cluster via seo_list_clusters.",
    ].join(" "),
    {
      name: z.string().trim().min(1).max(200).describe("Cluster name (must be unique for this brand)"),
      pillarKeyword: z.string().trim().min(1).optional().describe("Optional pillar keyword for the cluster"),
      description: z.string().trim().min(1).max(2000).optional().describe("Optional description"),
      brandId: brandOpt,
    },
    async ({ name, pillarKeyword, description, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { name };
      if (pillarKeyword !== undefined) body.pillarKeyword = pillarKeyword;
      if (description !== undefined) body.description = description;
      try {
        const data = await api.post<Record<string, unknown>>(
          `/api/agent/v1/brands/${id}/seo/clusters`,
          body
        );
        const cluster = data.cluster != null && typeof data.cluster === "object"
          ? (data.cluster as Record<string, unknown>)
          : data;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id: String(cluster.id ?? ""),
              name: String(cluster.name ?? ""),
              pillarKeyword: cluster.pillarKeyword != null ? String(cluster.pillarKeyword) : null,
              origin: cluster.origin != null ? String(cluster.origin) : "manual",
            }),
          }],
        };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && /cluster_name_taken/.test(err.message ?? "")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "cluster_name_taken",
                message: `A cluster named "${name}" already exists for this brand. Pick a different name, or call seo_list_clusters to find the existing one and add briefs to it with seo_create_custom_brief.`,
              }),
            }],
          };
        }
        throw err;
      }
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
}
