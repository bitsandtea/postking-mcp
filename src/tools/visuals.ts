import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

function slimAsset(a: Record<string, unknown>) {
  return {
    id: a.id as string | undefined,
    name: (a.name ?? null) as string | null,
    type: (a.type ?? null) as string | null,
    tags: (a.tags ?? []) as string[],
    url: (a.url ?? null) as string | null,
    isActive: (a.isActive ?? true) as boolean,
    description: (a.description ?? null) as string | null,
  };
}

const assetProjector: Projector<Record<string, unknown>> = {
  short: (a) => ({ id: a.id, type: a.type ?? null, name: a.name ?? null }),
  medium: (a) => slimAsset(a),
};

const stockProjector: Projector<Record<string, unknown>> = {
  short: (r) => ({
    url: r.url ?? r.photo_url ?? null,
    thumbnailUrl: r.thumbnailUrl ?? r.thumbnail_url ?? null,
  }),
  medium: (r) => ({
    url: r.url ?? r.photo_url ?? null,
    thumbnailUrl: r.thumbnailUrl ?? r.thumbnail_url ?? null,
    description: truncate(r.description ?? r.alt ?? null, 100),
    credit: r.credit ?? r.photographer ?? null,
  }),
};

export function registerVisualTools(server: McpServer) {
  // ── List assets ───────────────────────────────────────────────────────────
  server.tool(
    "list_assets",
    "List assets in the brand's visual library. Filter by type (IMAGE|DOCUMENT|VIDEO|LINK|LOTTIE), tags, or search text. Supports detail param: short=id+type+name, medium=key fields, full=raw.",
    {
      type: z.enum(["IMAGE", "DOCUMENT", "VIDEO", "LINK", "LOTTIE"]).optional().describe("Asset type filter: IMAGE | DOCUMENT | VIDEO | LINK | LOTTIE"),
      tags: z.string().optional().describe("Comma-separated tags to filter by"),
      search: z.string().optional().describe("Full-text search within asset name/description"),
      limit: z.number().int().min(1).max(200).optional().default(50),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ type, tags, search, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (tags) params.set("tags", tags);
      if (search) params.set("search", search);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/assets${qs}`);
      const rawAssets = (data?.assets ?? []) as Record<string, unknown>[];
      const result = { count: rawAssets.length, detail, assets: projectList(detail, rawAssets, assetProjector) };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── View asset ────────────────────────────────────────────────────────────
  server.tool(
    "view_asset",
    "View details of a single asset by ID. Supports detail param: short=id+type+name, medium=key fields, full=raw.",
    {
      assetId: z.string().describe("Asset ID from list_assets"),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ assetId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/assets/${assetId}`);
      const a = (data?.asset ?? data) as Record<string, unknown>;
      const result = project(detail, a, assetProjector);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Upload asset (base64) ─────────────────────────────────────────────────
  server.tool(
    "upload_asset",
    [
      "Upload an asset to the brand library by providing base64-encoded file content.",
      "Encode the file as base64 and pass it as fileBase64. Also provide the original fileName.",
      "Returns the new asset ID and URL.",
    ].join(" "),
    {
      fileBase64: z.string().describe("Base64-encoded file content"),
      fileName: z.string().describe("Original file name including extension, e.g. 'logo.png'"),
      name: z.string().optional().describe("Display name for the asset"),
      description: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Tags to apply, e.g. ['logo', 'brand']"),
      brandId: brandOpt,
    },
    async ({ fileBase64, fileName, name, description, tags, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/assets`, {
        fileBase64,
        fileName,
        name,
        description,
        tags,
      });
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
    }
  );

  // ── Import asset from URL ─────────────────────────────────────────────────
  server.tool(
    "import_asset_from_url",
    "Import an asset into the brand library from a public URL. The server fetches and stores the file.",
    {
      url: z.string().url().describe("Publicly accessible URL of the image/video/PDF to import"),
      name: z.string().optional().describe("Display name for the asset"),
      tags: z.array(z.string()).optional(),
      brandId: brandOpt,
    },
    async ({ url, name, tags, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/assets`, { url, name, tags });
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
    }
  );

  // ── Import assets from URL list ────────────────────────────────────────────
  server.tool(
    "import_assets_csv",
    "Batch-import up to 50 assets by providing an array of public URLs. All are added to the brand library. Supports detail param for the returned asset list.",
    {
      urls: z.array(z.string().url()).min(1).max(50).describe("Array of public URLs to import"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ urls, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/assets/import-urls`, { urls });
      const dataRec = data as Record<string, unknown>;
      const result = {
        imported: dataRec.imported ?? 0,
        errors: dataRec.errors ?? [],
        detail,
        assets: projectList(detail, (dataRec.assets ?? []) as Record<string, unknown>[], assetProjector),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Tag asset ─────────────────────────────────────────────────────────────
  server.tool(
    "tag_asset",
    "Add or remove tags on an asset. Provide addTags and/or removeTags as arrays.",
    {
      assetId: z.string().describe("Asset ID"),
      addTags: z.array(z.string()).optional().describe("Tags to add"),
      removeTags: z.array(z.string()).optional().describe("Tags to remove"),
      brandId: brandOpt,
    },
    async ({ assetId, addTags, removeTags, brandId }) => {
      const id = requireBrandId(brandId);
      if (!addTags?.length && !removeTags?.length) {
        return {
          content: [{ type: "text" as const, text: "Provide at least one of addTags or removeTags." }],
        };
      }
      const body: Record<string, unknown> = {};
      if (addTags?.length) body.addTags = addTags;
      if (removeTags?.length) body.removeTags = removeTags;
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/assets/${assetId}`, body);
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
    }
  );

  // ── Delete asset ──────────────────────────────────────────────────────────
  server.tool(
    "delete_asset",
    "Soft-delete an asset from the brand library. Pass confirm: true to proceed.",
    {
      assetId: z.string().describe("Asset ID to delete"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
      brandId: brandOpt,
    },
    async ({ assetId, brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/assets/${assetId}`);
      return {
        content: [{ type: "text" as const, text: `Asset ${assetId} deleted from library.` }],
      };
    }
  );

  // ── List asset tags ───────────────────────────────────────────────────────
  server.tool(
    "list_asset_tags",
    "List all unique tags used across the brand's asset library.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/assets/tags`);
      const tags: string[] = data?.tags ?? [];
      return { content: [{ type: "text" as const, text: JSON.stringify(tags, null, 2) }] };
    }
  );

  // ── Suggest assets for post ───────────────────────────────────────────────
  server.tool(
    "suggest_assets_for_post",
    "Get AI-suggested assets from the brand library that match a given post context or topic.",
    {
      context: z.string().describe("Post content or topic to find matching assets for"),
      limit: z.number().int().min(1).max(20).optional().default(5),
      brandId: brandOpt,
    },
    async ({ context, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams({ context });
      if (limit) params.set("limit", String(limit));
      const data = await api.get<any>(
        `/api/agent/v1/brands/${id}/assets/suggestions?${params}`
      );
      const suggestions = (data?.suggestions ?? data?.assets ?? []).map(slimAsset);
      return { content: [{ type: "text" as const, text: JSON.stringify(suggestions, null, 2) }] };
    }
  );

  // ── Search stock images ───────────────────────────────────────────────────
  server.tool(
    "search_stock_images",
    [
      "Search stock photo/video libraries for images matching a query.",
      "Returns URLs and descriptions. Use import_asset_from_url to add a result to the library.",
      "Supports detail param: short=url+thumbnail, medium=adds description+credit, full=raw.",
    ].join(" "),
    {
      query: z.string().describe("Search query, e.g. 'startup team meeting'"),
      platform: z.string().optional().describe("Platform to optimize image dimensions for, e.g. 'linkedin'"),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ query, platform, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { query };
      if (platform) body.medium = platform;
      const data = await api.post<any>(
        `/api/agent/v1/brands/${id}/assets/search-stock`,
        body
      );
      const rawResults = (data?.results ?? data?.photos ?? []) as Record<string, unknown>[];
      const result = { count: rawResults.length, detail, results: projectList(detail, rawResults, stockProjector) };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
