import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, type Detail, type Projector } from "../detail.js";

/**
 * Brand website links — the brand's OFFICIAL profiles and listings (LinkedIn,
 * X, YouTube, Facebook, Instagram, GitHub, Chrome Web Store…). Distinct from
 * the brand's main site URL, which these tools never touch. Recognised
 * profiles feed `Organization.sameAs` in exported JSON-LD.
 *
 * Read-only: get_brand_website_links.
 * Write tools: update_brand_website_links, enrich_brand_website_links.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface LinkEntry {
  url: string;
  kind: string;
  platform: string | null;
  inSameAs: boolean;
}
interface LinksResponse {
  links?: LinkEntry[];
  sameAs?: string[];
}

const linkProj: Projector<LinkEntry> = {
  short: (l) => l.url,
  medium: (l) => ({ url: l.url, kind: l.kind, platform: l.platform, inSameAs: l.inSameAs }),
};

function shape(data: LinksResponse | undefined, detail: Detail) {
  const links = Array.isArray(data?.links) ? data.links : [];
  return {
    count: links.length,
    links: links.map((l) => project(detail, l, linkProj)),
    sameAs: Array.isArray(data?.sameAs) ? data.sameAs : [],
  };
}

const urlList = (what: string) => z.array(z.string()).max(100).optional().describe(what);

export function registerWebsiteLinksTools(server: McpServer) {
  server.tool(
    "get_brand_website_links",
    [
      "List the brand's official profile and listing links (LinkedIn, X, YouTube, Facebook, Instagram, GitHub, Chrome Web Store, other).",
      "These are NOT the main site URL — that is never touched by these tools.",
      "Recognised profiles/listings feed Organization.sameAs in exported JSON-LD; `sameAs` in the result is exactly what will be emitted.",
      "short = URL strings; medium adds {kind, platform, inSameAs} per link; full = raw.",
    ].join(" "),
    { detail: detailParam("medium"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<LinksResponse>(`/api/agent/v1/brands/${id}/website-links`);
      const out = detail === "full" ? data : shape(data, detail);
      return { content: [{ type: "text" as const, text: JSON.stringify({ brandId: id, ...out }) }] };
    }
  );

  server.tool(
    "update_brand_website_links",
    [
      "Add, remove or replace the brand's official profile/listing links (https only; max 100).",
      "These are profiles and app-store listings, not the main site URL (which is never changed).",
      "They feed Organization.sameAs in exported JSON-LD, so only add pages that officially represent the brand.",
      "URLs are normalized (host lowercased, trailing slash and tracking params stripped) and deduped case-insensitively.",
      "Applied in order: replace (whole list), then remove, then add. Provide at least one of add/remove/replace; replace with [] clears the list.",
      "Returns the resulting links and the derived sameAs list.",
    ].join(" "),
    {
      add: urlList("https:// URLs to add. Already-present ones are ignored."),
      remove: urlList("URLs to remove (matched after normalization, case-insensitive)."),
      replace: urlList("Replace the entire list with exactly these URLs. Use with care."),
      detail: detailParam("medium"),
      brandId: brandOpt,
    },
    async ({ add, remove, replace, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (add !== undefined) body.add = add;
      if (remove !== undefined) body.remove = remove;
      if (replace !== undefined) body.replace = replace;
      const data = await api.patch<LinksResponse>(`/api/agent/v1/brands/${id}/website-links`, body);
      const out = detail === "full" ? data : shape(data, detail);
      return { content: [{ type: "text" as const, text: JSON.stringify({ brandId: id, ...out }) }] };
    }
  );

  server.tool(
    "enrich_brand_website_links",
    [
      "Scan the brand's own site pages for official profile links (LinkedIn, X, YouTube, Facebook, Instagram, GitHub) and app-store listings (Chrome Web Store) and add any new ones.",
      "Only ever ADDS — never removes or changes existing links, and never touches the main site URL.",
      "Added links feed Organization.sameAs in exported JSON-LD.",
      "Returns { added, alreadyPresent, pagesScanned } plus the full resulting links and sameAs. Fetches live pages, so it can take several seconds.",
    ].join(" "),
    { detail: detailParam("medium"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<LinksResponse & {
        added?: string[];
        alreadyPresent?: string[];
        pagesScanned?: number;
      }>(`/api/agent/v1/brands/${id}/website-links/enrich`, {});
      const out =
        detail === "full"
          ? data
          : {
              added: data?.added ?? [],
              alreadyPresent: data?.alreadyPresent ?? [],
              pagesScanned: data?.pagesScanned ?? 0,
              ...shape(data, detail),
            };
      return { content: [{ type: "text" as const, text: JSON.stringify({ brandId: id, ...out }) }] };
    }
  );
}
