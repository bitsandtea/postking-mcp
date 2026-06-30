import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireBrandId } from "../state.js";
import { brandDashboardUrl, type DashboardSection } from "../links.js";

const SECTIONS = [
  "overview",
  "seo",
  "seo_competitors",
  "seo_keywords",
  "seo_clusters",
  "seo_briefs",
  "seo_results",
  "posts",
  "blogs",
  "landing_pages",
  "reddit",
  "jobs",
  "weekly_schedule",
  "brandmind",
  "storylines",
  "knowledge",
  "trends",
  "competitors",
] as const;

export function registerLinkTools(server: McpServer) {
  server.tool(
    "dashboard_link",
    [
      "Return a clickable browser link to a PostKing dashboard page.",
      "ALWAYS use this instead of guessing dashboard URLs.",
      "The SEO roadmap / content plan is section 'seo_briefs' (or 'seo' for the overview) — there is NO '/seo/roadmap' page.",
    ].join(" "),
    {
      section: z
        .enum(SECTIONS)
        .optional()
        .describe(
          "Dashboard section to link to. Defaults to 'overview'. " +
          "SEO roadmap/content plan → 'seo_briefs'. Reddit module → 'reddit'."
        ),
      brandId: z.string().optional().describe("Brand ID (defaults to active brand)"),
    },
    async ({ section, brandId }) => {
      const id = requireBrandId(brandId);
      const sec: DashboardSection = section ?? "overview";
      const url = brandDashboardUrl(id, sec);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ url, section: sec, brandId: id }) }],
      };
    }
  );
}
