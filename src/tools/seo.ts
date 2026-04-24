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
 * Canonical flow:
 *   1. seo_add_seeds        → seed universe
 *   2. seo_generate_keywords → expand
 *   3. seo_categorize       → tag by intent
 *   4. seo_cluster          → group into topic clusters
 *   5. seo_list_clusters    → pick target
 *   6. seo_generate_roadmap → roadmap for a cluster
 *   7. seo_write_article    → draft articles
 *   8. seo_gap_analysis     → audit gaps
 *   9. seo_competitor_diff  → audit a competitor
 *  10. seo_publish_article  → publish/schedule
 *  11. seo_roadmap_stats    → progress report
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

export function registerSeoTools(server: McpServer) {
  // ── 1. Add seed keywords ──────────────────────────────────────────────────
  server.tool(
    "seo_add_seeds",
    [
      "Step 1 of the SEO flow. Add 3–10 seed keywords that describe what the brand wants to rank for.",
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
      "Step 2. Expand the seed keywords into a larger keyword universe.",
      "Uses credits. Default count=100. After this, call seo_categorize.",
    ].join(" "),
    {
      count: z.number().int().min(10).max(500).optional().default(100),
      brandId: brandOpt,
    },
    async ({ count, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/keywords/generate`,
        { count }
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

  // ── 3. Categorize ─────────────────────────────────────────────────────────
  server.tool(
    "seo_categorize",
    [
      "Step 3. Tag each keyword by search intent (informational, commercial, navigational, transactional).",
      "After this, call seo_cluster.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/categorize`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 4. Cluster ────────────────────────────────────────────────────────────
  server.tool(
    "seo_cluster",
    "Step 4. Group related keywords into topic clusters. Each cluster becomes a candidate pillar topic.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/cluster`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 5. List clusters ──────────────────────────────────────────────────────
  server.tool(
    "seo_list_clusters",
    "Step 5. List clusters so the agent can pick one to turn into a content roadmap.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/seo/clusters`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── 6. Generate roadmap ───────────────────────────────────────────────────
  server.tool(
    "seo_generate_roadmap",
    [
      "Step 6. Turn a cluster into a prioritized content roadmap of blog articles to write.",
      "Use clusterId from seo_list_clusters. After this, call seo_write_article.",
    ].join(" "),
    {
      clusterId: z.string().describe("Cluster ID from seo_list_clusters"),
      items: z.number().int().min(1).max(50).optional().default(20),
      brandId: brandOpt,
    },
    async ({ clusterId, items, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/seo/roadmap/generate`,
        { clusterId, items }
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

  // ── 7. Write article ──────────────────────────────────────────────────────
  server.tool(
    "seo_write_article",
    [
      "Step 7. Draft a full blog article for a roadmap item. Uses credits.",
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
}
