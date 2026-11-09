import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { brandDashboardUrl } from "../../links.js";

/**
 * SEO roadmap x real search data (feature 148). Search Console / Bing queries re-rank
 * suggested roadmap items, hide ones already covered, and add `refresh` items (rewrite an
 * existing weakly-ranking page). The reconcile runs on first sync and weekly; these two
 * tools read its state and trigger it manually.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

export function registerSeoSearchDataTools(server: McpServer) {
  server.tool(
    "seo_search_data_status",
    [
      "Is the brand's search data (Google Search Console / Bing) connected, and what did the last roadmap reconcile do?",
      "Returns {connected, hasData, connections, reconcile: {status, trigger, finishedAt, summary} | null, roadmap: {refreshOpen, refreshTotal, hidden, withSearchData}}.",
      "summary has movedUp / nowCovered / newKeywords / newTopics / refreshItems counts. reconcile=null means it never ran.",
      "Call this before seo_search_data_reconcile, and again to poll it (status generating -> completed | failed).",
      "To see the items: seo_list_roadmap with type=\"refresh\" (pages to rewrite) or status=\"ignored\" (hidden as already covered).",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/seo/search-data`);
      const base = data != null && typeof data === "object" ? (data as Record<string, unknown>) : { data };
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...base, dashboardUrl: brandDashboardUrl(id, "seo_plan") }, null, 2) }] };
    }
  );

  server.tool(
    "seo_search_data_reconcile",
    [
      "Re-run the search-data reconcile for the roadmap now, instead of waiting for the weekly run.",
      "It uses the brand's real search queries (last 90 days) to re-rank SUGGESTED roadmap items, hide items an existing page already covers (or that rank top 3), import observed keywords, and add or update `refresh` items for pages that rank poorly.",
      "Approved, writing, published and completed items are never re-ranked, and per-item overrides (restore / pin / remove via seo_roadmap_edit) are respected. It never rewrites an article by itself: refresh items only start when you call seo_roadmap_edit action=\"start\".",
      "Returns immediately (202); the work runs in the background. Poll seo_search_data_status until reconcile.status is completed (a minute or more; the summary then lists what changed).",
      "400 if no search data has synced yet (connect Search Console or Bing first); 409 if a run is already in progress.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/seo/search-data/reconcile`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
