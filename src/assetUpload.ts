// Asset-upload routing shared by upload_asset and upload_asset_finish.
//
// Videos and documents go straight to R2 through a presigned URL
// (upload-url → PUT → complete) because the app's request-body cap and the
// edge cap (30MB) make the base64-JSON path unusable for them. Images and
// everything else keep the original base64 POST, capped locally so we never
// send a request the server would silently truncate.
import { extname } from "node:path";

/** Raw-byte ceiling for the base64 JSON path (matches the server image cap; 10MB as base64 is ~13.4MB, under the 15MB inline body limit). */
export const MAX_BASE64_PATH_BYTES = 10 * 1024 * 1024;

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
};

const DOCUMENT_EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
};

const DOCUMENT_MIMES = new Set(Object.values(DOCUMENT_EXT_TO_MIME));

export type DirectAssetType = "VIDEO" | "DOCUMENT";

/** Returns the direct-to-R2 type and effective mime, or null when the base64 path applies. */
export function classifyDirectUpload(
  fileName: string | undefined,
  mimeType: string | undefined
): { type: DirectAssetType; mimeType: string } | null {
  const explicit = mimeType?.split(";")[0].trim().toLowerCase();
  if (explicit?.startsWith("video/")) return { type: "VIDEO", mimeType: explicit };
  if (explicit && DOCUMENT_MIMES.has(explicit)) return { type: "DOCUMENT", mimeType: explicit };
  if (explicit) return null; // explicit non-video/non-document mime wins over extension
  const ext = fileName ? extname(fileName).toLowerCase() : "";
  if (VIDEO_EXT_TO_MIME[ext]) return { type: "VIDEO", mimeType: VIDEO_EXT_TO_MIME[ext] };
  if (DOCUMENT_EXT_TO_MIME[ext]) return { type: "DOCUMENT", mimeType: DOCUMENT_EXT_TO_MIME[ext] };
  return null;
}

/** Local fail-fast message for non-direct files that would exceed the base64 path limit, else null. */
export function oversizeBase64Message(byteLength: number): string | null {
  if (byteLength <= MAX_BASE64_PATH_BYTES) return null;
  const mb = (byteLength / (1024 * 1024)).toFixed(1);
  return `File is ${mb}MB, over the 10MB limit for images and other non-video/non-document assets. Resize or compress it. Videos (mp4, webm, mov, avi, m4v; up to 500MB) and documents (pdf, doc, docx, txt; up to 50MB) upload directly and have no such limit.`;
}

export interface DirectUploadArgs {
  post: <T>(path: string, body?: unknown) => Promise<T>;
  fetchFn?: typeof fetch;
  brandId: string;
  bytes: Uint8Array;
  fileName: string;
  name?: string;
  description?: string;
  tags?: string[];
  type: DirectAssetType;
  mimeType: string;
}

interface UploadUrlResponse {
  uploadUrl: string;
  key?: string;
  uploadToken: string;
  headers: Record<string, string>;
}

/** upload-url → PUT to R2 (unauthenticated, exact signed headers) → complete. Returns the complete response. */
export async function uploadDirect(a: DirectUploadArgs): Promise<unknown> {
  const doFetch = a.fetchFn ?? fetch;
  const base = `/api/agent/v1/brands/${a.brandId}/assets`;
  const presign = await a.post<UploadUrlResponse>(`${base}/upload-url`, {
    name: a.name ?? a.fileName,
    fileName: a.fileName,
    type: a.type,
    mimeType: a.mimeType,
    fileSize: a.bytes.byteLength,
  });

  const put = await doFetch(presign.uploadUrl, {
    method: "PUT",
    headers: presign.headers,
    body: a.bytes as unknown as BodyInit,
  });
  if (!put.ok) {
    const text = await put.text().catch(() => "");
    throw new Error(`Direct upload to storage failed: HTTP ${put.status} ${text}`.trim());
  }

  return a.post<unknown>(`${base}/complete`, {
    uploadToken: presign.uploadToken,
    name: a.name ?? a.fileName,
    ...(a.description ? { description: a.description } : {}),
    ...(a.tags && a.tags.length ? { tags: a.tags } : {}),
  });
}
