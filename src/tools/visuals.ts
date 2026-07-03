import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Chunked upload state ──────────────────────────────────────────────────
// Chunking only needs to survive the LLM→MCP tool_call hop (large base64
// strings get truncated crossing that boundary over the remote/HTTP
// transport). The MCP→PostKing hop is a normal server-to-server request with
// no such limit, so we buffer chunks in memory here, reassemble the full
// base64 string, and make one existing-shape call to PostKing — identical to
// what `upload_asset` already does.
const UPLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BUFFERED_BASE64_CHARS = 20 * 1024 * 1024; // ~20MB of base64 chars

interface PendingUpload {
  fileName?: string;
  mimeType?: string;
  name?: string;
  description?: string;
  tags?: string[];
  brandId?: string;
  expectedSize?: number;
  expectedSha256?: string;
  chunks: Map<number, string>;
  createdAt: number;
  totalBufferedBytes: number;
}

const uploads = new Map<string, PendingUpload>();

function evictStaleUploads() {
  const now = Date.now();
  for (const [uploadId, entry] of uploads) {
    if (now - entry.createdAt > UPLOAD_TTL_MS) {
      uploads.delete(uploadId);
    }
  }
}

// Checks decoded file bytes against known image magic numbers. Returns a
// human-readable mismatch message if `mimeType` is a known image type and the
// leading bytes don't match, or `null` if they match / mimeType is absent or
// unrecognized (non-image uploads skip this check entirely).
function imageMagicMismatch(buffer: Buffer, mimeType?: string): string | null {
  if (!mimeType) return null;
  const mismatch = `leading bytes do not match ${mimeType} magic number`;
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return mismatch;
      return null;
    case "image/png":
      if (
        buffer.length < 8 ||
        buffer[0] !== 0x89 ||
        buffer[1] !== 0x50 ||
        buffer[2] !== 0x4e ||
        buffer[3] !== 0x47 ||
        buffer[4] !== 0x0d ||
        buffer[5] !== 0x0a ||
        buffer[6] !== 0x1a ||
        buffer[7] !== 0x0a
      )
        return mismatch;
      return null;
    case "image/gif":
      if (buffer.length < 3 || buffer[0] !== 0x47 || buffer[1] !== 0x49 || buffer[2] !== 0x46) return mismatch;
      return null;
    case "image/webp":
      if (
        buffer.length < 12 ||
        buffer[0] !== 0x52 ||
        buffer[1] !== 0x49 ||
        buffer[2] !== 0x46 ||
        buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 ||
        buffer[9] !== 0x45 ||
        buffer[10] !== 0x42 ||
        buffer[11] !== 0x50
      )
        return mismatch;
      return null;
    default:
      return null;
  }
}

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

  // ── Upload asset (file path or base64) ────────────────────────────────────
  server.tool(
    "upload_asset",
    [
      "Upload an asset to the brand library from a local file path or base64-encoded content.",
      "Prefer filePath for local files: the server reads and base64-encodes the file itself, avoiding truncation of large base64 strings over the tool_call boundary.",
      "fileBase64 is still supported for remote/inline use where no local path is available.",
      "For large files over the remote/HTTP transport, a single fileBase64 string can get truncated crossing the LLM→tool_call boundary — use the chunked flow instead: upload_asset_begin → upload_asset_chunk (× N) → upload_asset_finish.",
      "Provide exactly one of filePath or fileBase64.",
      "Returns the new asset ID and URL.",
    ].join(" "),
    {
      filePath: z.string().optional().describe("Absolute path to a local file to upload. Preferred over fileBase64 for local files."),
      fileBase64: z.string().optional().describe("Base64-encoded file content. Use filePath instead when the file is local."),
      fileName: z.string().optional().describe("Original file name including extension, e.g. 'logo.png'. Derived from filePath if omitted."),
      mimeType: z.string().optional().describe("MIME type of the file, e.g. 'image/png'"),
      name: z.string().optional().describe("Display name for the asset"),
      description: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Tags to apply, e.g. ['logo', 'brand']"),
      brandId: brandOpt,
    },
    async ({ filePath, fileBase64, fileName, mimeType, name, description, tags, brandId }) => {
      if (!filePath && !fileBase64) {
        return {
          content: [{ type: "text" as const, text: "Provide exactly one of filePath or fileBase64." }],
        };
      }
      if (filePath && fileBase64) {
        return {
          content: [{ type: "text" as const, text: "Provide only one of filePath or fileBase64, not both." }],
        };
      }

      const id = requireBrandId(brandId);

      let resolvedFileBase64: string;
      let resolvedFileName: string | undefined = fileName;
      let fileSize: number;
      let sha256: string;

      if (filePath) {
        let buffer: Buffer;
        try {
          buffer = await readFile(filePath);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Could not read file at ${filePath}: ${reason}` }],
          };
        }
        resolvedFileName = resolvedFileName ?? basename(filePath);
        fileSize = buffer.byteLength;
        sha256 = createHash("sha256").update(buffer).digest("hex");
        resolvedFileBase64 = buffer.toString("base64");
      } else {
        const buffer = Buffer.from(fileBase64 as string, "base64");
        const mismatch = imageMagicMismatch(buffer, mimeType);
        if (mismatch) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Decoded data is not a valid ${mimeType} image (leading bytes don't match). The base64 was likely corrupted or double-encoded — re-read/re-encode the file and retry.`,
              },
            ],
          };
        }
        fileSize = buffer.byteLength;
        sha256 = createHash("sha256").update(buffer).digest("hex");
        resolvedFileBase64 = fileBase64 as string;
      }

      const data = await api.post<any>(`/api/agent/v1/brands/${id}/assets`, {
        fileBase64: resolvedFileBase64,
        fileName: resolvedFileName,
        name,
        description,
        tags,
        mimeType,
        fileSize,
        sha256,
      });
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
    }
  );

  // ── Upload asset — chunked flow (begin) ────────────────────────────────────
  server.tool(
    "upload_asset_begin",
    [
      "Start a chunked asset upload. Use this instead of upload_asset's fileBase64 param for large files over the remote/HTTP transport, where a single large base64 string can get truncated crossing the LLM→tool_call boundary.",
      "Flow: upload_asset_begin (once) → upload_asset_chunk (once per chunk, in order) → upload_asset_finish (once).",
      "Returns an uploadId that expires after 10 minutes of inactivity.",
    ].join(" "),
    {
      fileName: z.string().describe("Original file name including extension, e.g. 'logo.png'."),
      fileSize: z.number().optional().describe("Raw decoded byte length of the original file. Recommended — enables truncation/corruption detection at finish time."),
      sha256: z.string().optional().describe("Sha256 hex digest of the original file's decoded bytes. Recommended — enables end-to-end integrity verification at finish time."),
      mimeType: z.string().optional().describe("MIME type of the file, e.g. 'image/png'"),
      name: z.string().optional().describe("Display name for the asset"),
      description: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Tags to apply, e.g. ['logo', 'brand']"),
      brandId: brandOpt,
    },
    async ({ fileName, fileSize, sha256, mimeType, name, description, tags, brandId }) => {
      evictStaleUploads();
      const id = requireBrandId(brandId);
      const uploadId = randomUUID();
      uploads.set(uploadId, {
        fileName,
        mimeType,
        name,
        description,
        tags,
        brandId: id,
        expectedSize: fileSize,
        expectedSha256: sha256,
        chunks: new Map(),
        createdAt: Date.now(),
        totalBufferedBytes: 0,
      });
      const recommendedChunkChars = 16000;
      const result = {
        uploadId,
        recommendedChunkChars,
        hint: `Base64-encode the file, split the base64 string into ordered chunks of at most ${recommendedChunkChars} characters each, then call upload_asset_chunk once per chunk with index starting at 0 and increasing contiguously. After the last chunk, call upload_asset_finish with this uploadId.`,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Upload asset — chunked flow (chunk) ─────────────────────────────────────
  server.tool(
    "upload_asset_chunk",
    "Send one chunk of a base64-encoded file previously started with upload_asset_begin. Chunks must be sent in order, index starting at 0, with no gaps.",
    {
      uploadId: z.string().describe("Upload ID returned by upload_asset_begin"),
      index: z.number().int().min(0).describe("0-based, contiguous chunk index"),
      fileBase64Chunk: z.string().describe("A slice of the full base64 string for this chunk"),
    },
    async ({ uploadId, index, fileBase64Chunk }) => {
      const entry = uploads.get(uploadId);
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Unknown or expired uploadId ${uploadId}. Call upload_asset_begin first.` }],
        };
      }

      entry.totalBufferedBytes += fileBase64Chunk.length;
      if (entry.totalBufferedBytes > MAX_BUFFERED_BASE64_CHARS) {
        uploads.delete(uploadId);
        return {
          content: [{ type: "text" as const, text: `File is too large for chunked upload (exceeds ${MAX_BUFFERED_BASE64_CHARS} base64 characters). The upload has been aborted; try a smaller file.` }],
        };
      }

      entry.chunks.set(index, fileBase64Chunk);
      const result = {
        uploadId,
        received: entry.chunks.size,
        bufferedBase64Chars: entry.totalBufferedBytes,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Upload asset — chunked flow (finish) ────────────────────────────────────
  server.tool(
    "upload_asset_finish",
    "Finalize a chunked asset upload: reassembles the buffered chunks, verifies integrity, and uploads the asset to the brand library. Returns the new asset ID and URL.",
    { uploadId: z.string().describe("Upload ID returned by upload_asset_begin") },
    async ({ uploadId }) => {
      const entry = uploads.get(uploadId);
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Unknown or expired uploadId ${uploadId}. Call upload_asset_begin first.` }],
        };
      }

      const total = entry.chunks.size;
      const missing: number[] = [];
      for (let i = 0; i < total; i++) {
        if (!entry.chunks.has(i)) missing.push(i);
      }
      if (missing.length > 0) {
        return {
          content: [{ type: "text" as const, text: `Chunk sequence has gaps at index ${missing.join(", ")}. Resend the missing chunk(s) via upload_asset_chunk, then call upload_asset_finish again.` }],
        };
      }

      const parts: string[] = [];
      for (let i = 0; i < total; i++) {
        parts.push(entry.chunks.get(i) as string);
      }
      const full = parts.join("");
      const decoded = Buffer.from(full, "base64");

      if (entry.expectedSize !== undefined && decoded.byteLength !== entry.expectedSize) {
        uploads.delete(uploadId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Reassembled file appears truncated or corrupt: expected ${entry.expectedSize} bytes, got ${decoded.byteLength} bytes. The upload has been discarded — start over with upload_asset_begin.`,
            },
          ],
        };
      }

      const fileSize = decoded.byteLength;
      const sha256 = createHash("sha256").update(decoded).digest("hex");

      if (entry.expectedSha256 !== undefined && sha256.toLowerCase() !== entry.expectedSha256.toLowerCase()) {
        uploads.delete(uploadId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Reassembled file appears truncated or corrupt: sha256 mismatch (expected ${entry.expectedSha256}, got ${sha256}). The upload has been discarded — start over with upload_asset_begin.`,
            },
          ],
        };
      }

      const magicMismatch = imageMagicMismatch(decoded, entry.mimeType);
      if (magicMismatch) {
        uploads.delete(uploadId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Decoded data is not a valid ${entry.mimeType} image (leading bytes don't match). The base64 was likely corrupted or double-encoded — the upload has been discarded, start over with upload_asset_begin using a correct encode.`,
            },
          ],
        };
      }

      const data = await api.post<any>(`/api/agent/v1/brands/${entry.brandId}/assets`, {
        fileBase64: full,
        fileName: entry.fileName,
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
        mimeType: entry.mimeType,
        fileSize,
        sha256,
      });
      uploads.delete(uploadId);
      const a = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(slimAsset(a), null, 2) }] };
    }
  );

  // ── Upload asset — chunked flow (abort) ─────────────────────────────────────
  server.tool(
    "upload_asset_abort",
    "Cancel a chunked asset upload in progress and discard any buffered chunks.",
    { uploadId: z.string().describe("Upload ID returned by upload_asset_begin") },
    async ({ uploadId }) => {
      const found = uploads.delete(uploadId);
      return {
        content: [
          {
            type: "text" as const,
            text: found ? `Upload ${uploadId} aborted and buffered chunks discarded.` : `No in-progress upload found for uploadId ${uploadId}; nothing to abort.`,
          },
        ],
      };
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
