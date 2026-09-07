import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { detailParam, project, projectList, type Projector } from "../../detail.js";
import { brandDashboardUrl } from "../../links.js";

/**
 * SEO / GEO flow — content roadmap (blog topics queued for writing) CRUD + stats.
 *
 * Step 6 of the canonical flow (see prompts.ts `seo_end_to_end` for the source
 * of truth): cluster → roadmap. See src/tools/seo/index.ts for the full flow doc
 * comment.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface CompactRoadmapItem {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  primaryKeywords: string[];
  clusterId: string | null;
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

const roadmapItemProj: Projector<Record<string, unknown>> = {
  short: (item) => ({ id: String(item.id ?? ""), title: String(item.title ?? ""), status: String(item.status ?? "") }),
  medium: projectRoadmapItem,
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

export function registerSeoRoadmapTools(server: McpServer) {
  // ── 6. Generate roadmap ───────────────────────────────────────────────────
  server.tool(
    "seo_generate_roadmap",
    [
      "Step 6. Turn one or more clusters into a prioritized content roadmap of blog articles to write.",
      "Pass `clusterId` (single) or `clusterIds` (array of cluster IDs from seo_list_clusters) — omit both to roadmap all clusters.",
      "After this, call seo_write_article.",
      "Pass `languageCode` to scope brief generation to one language when clusterIds is omitted or spans more than one cluster — ignored for a single explicit clusterId, whose own language wins. Omit to use the brand's first configured SEO market language. This WRITES brief/roadmap rows stamped with that language — get it wrong and you mis-stamp them, not just filter a read.",
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
      languageCode: z
        .string()
        .optional()
        .describe(
          "DataForSEO-vocabulary language code scoping brief generation to one language, when clusterIds is omitted or spans more than one cluster (ignored for a single explicit clusterId — re-derived from that cluster's own language). Omit to use the brand's first configured SEO market language."
        ),
      brandId: brandOpt,
    },
    async ({ clusterId, clusterIds, languageCode, brandId }) => {
      const id = requireBrandId(brandId);
      const merged = [
        ...(clusterIds ?? []),
        ...(clusterId ? [clusterId] : []),
      ];
      const body: Record<string, unknown> = {};
      if (merged.length > 0) body.clusterIds = merged;
      if (languageCode !== undefined) body.languageCode = languageCode;
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
    [
      "Edit a roadmap item's status. Pass EITHER `action` (a shortcut) OR `status` directly — the server requires at least one.",
      "`action` shortcuts: \"ignore\" (dismiss the suggestion, status -> ignored, stamps ignoredAt), \"restore\" (bring an ignored item back, status -> suggested, clears ignoredAt), \"start\" (status -> in_progress, clears ignoredAt/completedAt), \"complete\" (status -> completed, stamps completedAt).",
      "There is no title or priority field on this endpoint — the roadmap item's title and priority cannot be edited via this tool (or the underlying server route at all).",
    ].join(" "),
    {
      itemId: z.string().describe("Roadmap item ID from seo_list_roadmap"),
      action: z
        .enum(["ignore", "restore", "start", "complete"])
        .optional()
        .describe("Shortcut status transition: ignore -> ignored, restore -> suggested, start -> in_progress, complete -> completed."),
      status: z
        .enum(["suggested", "in_progress", "completed", "ignored"])
        .optional()
        .describe("Set the status directly. Omit if using `action` instead."),
      brandId: brandOpt,
    },
    async ({ itemId, action, status, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (action !== undefined) body.action = action;
      if (status !== undefined) body.status = status;
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
}
