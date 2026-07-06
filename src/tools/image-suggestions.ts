import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface ImageResult {
  id: string;
  url: string;
  alt: string;
  source: string;
  sourceUrl: string;
  width: number;
  height: number;
}

const imageProjector: Projector<ImageResult> = {
  short: (r) => ({ url: r.url, source: r.source }),
  medium: (r) => ({
    url: r.url,
    source: r.source,
    sourceUrl: r.sourceUrl,
    alt: r.alt,
    width: r.width,
    height: r.height,
  }),
};

export function registerImageSuggestionTools(server: McpServer) {
  // ── Search web images (Google Images) ─────────────────────────────────────
  server.tool(
    "search_web_images",
    [
      "Search Google Images across the whole web for a query — broader than search_stock_images, which only searches licensed stock photo/video libraries.",
      "Returns image URLs, the source site, and a link back to the source page.",
      "openLicensedOnly is a best-effort source filter, not a legal license guarantee — agents and users should still verify usage rights before publishing any result.",
      "Use import_asset_from_url to add a chosen result to the library.",
      "Supports detail param: short=url+source, medium=adds sourceUrl+alt+dimensions, full=raw.",
    ].join(" "),
    {
      brandId: brandOpt,
      query: z.string().describe("Search query, e.g. 'startup team meeting'"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return (1–100)"),
      gl: z.string().optional().describe("Google country code to bias results, e.g. 'us'"),
      hl: z.string().optional().describe("Google language code, e.g. 'en'"),
      openLicensedOnly: z
        .boolean()
        .optional()
        .describe("Best-effort filter to sources that tend to be openly licensed. Not a legal guarantee — still verify usage rights before publishing."),
      detail: detailParam("short"),
    },
    async ({ brandId, query, maxResults, gl, hl, openLicensedOnly, detail }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { query };
      if (maxResults !== undefined) body.maxResults = maxResults;
      if (gl !== undefined) body.gl = gl;
      if (hl !== undefined) body.hl = hl;
      if (openLicensedOnly !== undefined) body.openLicensedOnly = openLicensedOnly;
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/image-suggestions`, body);
      const results = (data?.results ?? []) as ImageResult[];
      const result = { count: results.length, detail, results: projectList(detail, results, imageProjector) };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
