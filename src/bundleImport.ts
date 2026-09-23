/**
 * Server-side fetch-and-forward helper for the `import_landing_page_bundle`
 * MCP tool (PostKing feature 126 — bundle import, Phase 3).
 *
 * Unlike the CLI (which walks a real local directory), this tool's callers
 * hand over a manifest of `{path, url}` pairs — files already hosted
 * somewhere reachable. This module fetches each URL from the MCP server
 * process itself (bounded concurrency), enforces the same byte caps the
 * bundle-import endpoint documents, and assembles one multipart `FormData`
 * ready to forward to `POST /api/agent/v1/landing-pages/import-html-bundle`.
 *
 * The actual networking — SSRF guarding (DNS-rebinding-safe, redirect-aware)
 * and the per-file/shared-total byte caps — lives in `safeFetch.ts`; this
 * module just supplies the caps and assembles the manifest.
 */
import { ByteBudget, SafeFetchError, safeFetch } from "./safeFetch.js";

export interface BundleManifestFile {
  path: string;
  url: string;
}

export const MAX_BUNDLE_FILES = 500;
export const MAX_BUNDLE_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const MAX_DEFAULT_BYTES = 20 * 1024 * 1024; // 20 MB — html/js/other text, image/font/video
const MAX_CSS_BYTES = 2 * 1024 * 1024; // 2 MB
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 30_000;

const CSS_EXTS = new Set([".css"]);

/** Thrown when one manifest entry can't be fetched/validated — the whole import aborts, naming which entry failed. */
export class BundleFetchError extends Error {
  constructor(public readonly path: string, message: string) {
    super(message);
    this.name = "BundleFetchError";
  }
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

function capForExt(ext: string): number {
  return CSS_EXTS.has(ext) ? MAX_CSS_BYTES : MAX_DEFAULT_BYTES;
}

async function fetchOne(file: BundleManifestFile, budget: ByteBudget): Promise<{ path: string; blob: Blob }> {
  const cap = capForExt(extOf(file.path));

  let result;
  try {
    result = await safeFetch(file.url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBodyBytes: cap,
      budget,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      throw new BundleFetchError(file.path, err.message);
    }
    throw new BundleFetchError(file.path, `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new BundleFetchError(file.path, `fetch returned HTTP ${result.status}`);
  }

  const contentType = result.headers["content-type"] ?? "application/octet-stream";
  // `Buffer`'s backing type is `ArrayBufferLike` (could in principle be a
  // `SharedArrayBuffer`), which `BlobPart` doesn't accept — this view copy is
  // the one unavoidable conversion, done once here rather than per-chunk.
  return { path: file.path, blob: new Blob([new Uint8Array(result.body)], { type: contentType }) };
}

/** Small inline bounded-concurrency pool — no new dependency for a handful of parallel fetches. */
async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Fetches every manifest file (bounded concurrency) and assembles a
 * multipart `FormData` with one `files` part per entry, named by its
 * relative bundle path — the same shape the CLI's direct-upload path builds.
 * Any single fetch/cap failure aborts the whole call (thrown as
 * `BundleFetchError`, naming the offending path) rather than partially
 * importing a bundle.
 */
export async function fetchBundleFiles(files: BundleManifestFile[]): Promise<FormData> {
  if (files.length === 0) {
    throw new BundleFetchError("", "files must be a non-empty array");
  }
  if (files.length > MAX_BUNDLE_FILES) {
    throw new BundleFetchError("", `${files.length} files exceeds the ${MAX_BUNDLE_FILES}-file cap`);
  }

  // Shared across every concurrent fetch in this call so the running total is
  // enforced in real time (mid-stream), not just summed up after the fact.
  const budget = new ByteBudget(MAX_BUNDLE_TOTAL_BYTES);
  const fetched = await mapLimit(files, FETCH_CONCURRENCY, (f) => fetchOne(f, budget));

  // Redundant with the shared budget above (which aborts mid-stream), kept as
  // a cheap final sanity check.
  let totalBytes = 0;
  for (const f of fetched) totalBytes += f.blob.size;
  if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
    throw new BundleFetchError(
      "",
      `bundle totals ${(totalBytes / (1024 * 1024)).toFixed(1)}MB, exceeding the ${(MAX_BUNDLE_TOTAL_BYTES / (1024 * 1024)).toFixed(0)}MB total cap`
    );
  }

  const form = new FormData();
  for (const f of fetched) {
    form.append("files", f.blob, f.path);
  }
  return form;
}
