import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

function slimAsset(a: any) {
  return {
    id: a.id,
    name: a.name ?? null,
    type: a.type ?? null,
    tags: a.tags ?? [],
    url: a.url ?? null,
    isActive: a.isActive ?? true,
    description: a.description ?? null,
  };
}

export function registerVisualTools(server: McpServer) {
  // ── List assets ───────────────────────────────────────────────────────────
  server.tool(
    "list_assets",
    "List assets in the brand's visual library. Filter by type (image|video|gif|pdf), tags, or search text.",
    {
      type: z.enum(["image", "video", "gif", "pdf"]).optional().describe("Asset type filter"),
      tags: z.string().optional().describe("Comma-separated tags to filter by"),
      search: z.string().optional().describe("Full-text search within asset name/description"),
      limit: z.number().int().min(1).max(200).optional().default(50),
      brandId: brandOpt,
    },
    async ({ type, tags, search, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (tags) params.set("tags", tags);
      if (search) params.set("search", search);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/assets${qs}`);
      const assets = (data?.assets ?? []).map(slimAsset);
      return { content: [{ type: "text" as const, text: JSON.stringify(assets, null, 2) }] };
    }
  );

  // ── View asset ────────────────────────────────────────────────────────────
  server.tool(
    "view_asset",
    "View full details of a single asset by ID.",
    {
      assetId: z.string().describe("Asset ID from list_assets"),
      brandId: brandOpt,
    },
    async ({ assetId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/assets/${assetId}`);
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
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
    "Batch-import up to 50 assets by providing an array of public URLs. All are added to the brand library.",
    {
      urls: z.array(z.string().url()).min(1).max(50).describe("Array of public URLs to import"),
      brandId: brandOpt,
    },
    async ({ urls, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/assets/import-urls`, { urls });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
    ].join(" "),
    {
      query: z.string().describe("Search query, e.g. 'startup team meeting'"),
      platform: z.string().optional().describe("Platform to optimize image dimensions for, e.g. 'linkedin'"),
      brandId: brandOpt,
    },
    async ({ query, platform, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { query };
      if (platform) body.medium = platform;
      const data = await api.post<any>(
        `/api/agent/v1/brands/${id}/assets/search-stock`,
        body
      );
      const results = data?.results ?? data?.photos ?? [];
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );
}
