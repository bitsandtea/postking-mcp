import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { toUrlSegment } from "../sidePageSlug.js";

// Headless sync: a customer keeps their own site and renders static HTML from
// PostKing content. Loop: list_content_changes(since=lastServerTime) -> export
// each changed item -> store serverTime. Export payloads are returned whole;
// they are never truncated.

const versionParam = z
  .enum(["published", "draft"])
  .default("published")
  .describe('"published" (default) = what is live. "draft" = the editor\'s current version, for previews only.');

const ifContentHashParam = z
  .string()
  .optional()
  .describe("meta.contentHash from your last export of this item; if unchanged you get { unchanged: true } instead of the body.");

const brandIdParam = z.string().optional().describe("Brand ID (uses active brand if omitted)");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function registerExportTools(server: McpServer) {
  server.tool(
    "list_content_changes",
    [
      "Sync step 1. Lists published blog articles, side pages, landing pages and blog category hubs (type category, with url/path) that changed since a timestamp, oldest first.",
      "Loop: call with since=<serverTime from your last sync> (omit on first sync), export_* each returned item, then store the response's serverTime. Follow nextCursor while hasMore.",
      'Rows with status "unpublished" changed and are no longer public: remove them from your site. since is inclusive; re-delivery is harmless, dedupe by id + updatedAt/contentHash.',
      "Deleted items (including categories) arrive as { type, id, status: \"deleted\", previousUrls } tombstones on since-syncs. Also occasionally call with includeIds=true and delete anything on your site whose id is missing from publishedIds.",
    ].join(" "),
    {
      since: z.string().optional().describe("ISO-8601; previous response's serverTime. Omit for a full initial sync."),
      types: z
        .array(z.enum(["blog_article", "side_page", "landing_page", "category"]))
        .optional()
        .describe("Restrict to these types (default all four)."),
      status: z.enum(["published", "all"]).default("published").describe('"all" also lists never-published drafts.'),
      cursor: z.string().optional().describe("nextCursor from the previous page."),
      limit: z.number().int().min(1).max(500).default(100),
      includeIds: z.boolean().default(false).describe("Also return the complete set of currently published ids per type, for deletion reconciliation."),
      brandId: brandIdParam,
    },
    async ({ since, types, status, cursor, limit, includeIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/content/changes${qs({
          since,
          types: types?.join(","),
          status,
          cursor,
          limit,
          includeIds: includeIds ? "true" : undefined,
        })}`
      );
      return json(data);
    }
  );

  server.tool(
    "export_blog_article",
    "Sync step 2. Render-ready PUBLISHED blog article: HTML body with absolute image/link URLs, schemaGraph (JSON-LD), siteMetadata, canonical, author, breadcrumb, related posts, plus meta (contentHash, updatedAt, publishedAt, path). Full payload, never truncated. Identify by id or slug (add publicationId if the slug exists in several publications).",
    {
      id: z.string().optional().describe("Article id (from list_content_changes)."),
      slug: z.string().optional().describe("Article slug."),
      publicationId: z.string().optional(),
      version: versionParam,
      ifContentHash: ifContentHashParam,
      brandId: brandIdParam,
    },
    async ({ id: articleId, slug, publicationId, version, ifContentHash, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/export/blog-article${qs({ id: articleId, slug, publicationId, version, ifContentHash })}`
      );
      return json(data);
    }
  );

  server.tool(
    "export_side_page",
    "Sync step 2. Render-ready PUBLISHED side page: typed content, resolved assets[] with absolute fileUrl, slotMap, navigation, siteMetadata, canonicalUrl, breadcrumb, schemaGraph (JSON-LD @graph: Organization, WebSite, WebPage, BreadcrumbList, FAQPage, comparison ItemList), plus meta (contentHash, updatedAt, publishedAt, publishedVersionId, path, assetMode). meta.assetMode 'client' (page distribution 'external') means asset keys (assets, slotMap, logo/OG images, slot refs) are deliberately omitted — the site supplies its own. Full payload, never truncated. Nested keys: features/a or features~a.",
    {
      landingPageSlug: z.string().describe("Parent landing page slug (rows from list_content_changes carry it as parentSlug)."),
      sideKey: z.string().describe("Side page key/slug (row.slug)."),
      version: versionParam,
      ifContentHash: ifContentHashParam,
      brandId: brandIdParam,
    },
    async ({ landingPageSlug, sideKey, version, ifContentHash, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/export/side-page${qs({
          landingPageSlug,
          sideKey: toUrlSegment(sideKey),
          version,
          ifContentHash,
        })}`
      );
      return json(data);
    }
  );

  server.tool(
    "export_landing_page",
    "Sync step 2. Render-ready PUBLISHED landing page: content, config, navigation, siteMetadata, assets[] with absolute fileUrl, slotMap, sectionOrder, sitemap, rawHtml for raw-HTML pages, language alternates, plus meta (contentHash, updatedAt, publishedAt, publishedVersionId, path). Full payload, never truncated.",
    {
      slug: z.string().describe("Landing page slug."),
      version: versionParam,
      ifContentHash: ifContentHashParam,
      brandId: brandIdParam,
    },
    async ({ slug, version, ifContentHash, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/export/landing-page${qs({ slug, version, ifContentHash })}`
      );
      return json(data);
    }
  );

  server.tool(
    "export_site_index",
    "Map of everything currently published: landing pages (each with its side pages and stored sitemap), blog publications with article counts, and published blog article rows (same row shape as list_content_changes). Use for the first sync or to enumerate pages; published only.",
    {
      landingPageSlug: z.string().optional().describe("Restrict the landing-page section to one slug."),
      brandId: brandIdParam,
    },
    async ({ landingPageSlug, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/export/site-index${qs({ landingPageSlug })}`);
      return json(data);
    }
  );
}
