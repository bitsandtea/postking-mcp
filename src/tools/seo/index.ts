import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSeoKeywordTools } from "./keywords.js";
import { registerSeoClusterTools } from "./clusters.js";
import { registerSeoRoadmapTools } from "./roadmap.js";
import { registerSeoBriefTools } from "./briefs.js";
import { registerSeoResultsTools } from "./results.js";
import { registerSeoSidePageTools } from "./side-pages.js";

/**
 * SEO end-to-end agentic flow.
 *
 * Every tool here is a one-call wrapper around the /api/agent/v1/brands/{id}/seo/*
 * endpoints shipped by Team B. No business logic lives here — the agent flow is
 * composed by the LLM using the tool descriptions below as its playbook.
 *
 * Canonical flow (see prompts.ts `seo_end_to_end` for the source of truth):
 *   1. Seed              → seo_add_seeds                          (keywords.ts)
 *   2. Expand            → seo_generate_keywords (async — poll via get_job)  (keywords.ts)
 *   3. Categorize        → seo_categorize                          (keywords.ts)
 *   4. Cluster           → seo_generate_clusters (async — poll via get_job)  (clusters.ts)
 *      Manual cluster    → seo_create_cluster (synchronous, no pipeline)     (clusters.ts)
 *   5. Approve clusters  → seo_bulk_approve_clusters / seo_approve_cluster   (clusters.ts)
 *   6. Roadmap           → seo_generate_roadmap                             (roadmap.ts)
 *   7. Review & approve briefs → seo_list_briefs → seo_edit_brief → seo_approve_briefs  (briefs.ts)
 *      Custom brief      → seo_create_custom_brief (async — poll via get_job) (briefs.ts)
 *   8. Write — seo_approve_briefs auto-fires article generation and returns operationIds;
 *      poll each with get_job until state is `completed`. (seo_write_article is only for
 *      (re)generating an article when approval was not used.)                (briefs.ts)
 *   9. Audit & Publish   → seo_gap + seo_competitor + seo_publish_article + seo_roadmap_stats
 *                                                                            (results.ts, roadmap.ts)
 *   10. Side pages / comparisons → seo_generate_side_page, create_comparison_page (side-pages.ts)
 *
 * Steps 5 and 7 are explicit human-in-the-loop approval gates.
 *
 * This module was split out of a single 1510-line seo.ts (over the repo's 800-line
 * file-size limit) into one file per tool group, each exporting a single
 * `register*Tools(server)` entry point. Behavior of every pre-existing tool is
 * unchanged — this was a mechanical move, not a rewrite.
 */
export function registerSeoTools(server: McpServer) {
  registerSeoKeywordTools(server);
  registerSeoClusterTools(server);
  registerSeoRoadmapTools(server);
  registerSeoBriefTools(server);
  registerSeoResultsTools(server);
  registerSeoSidePageTools(server);
}
