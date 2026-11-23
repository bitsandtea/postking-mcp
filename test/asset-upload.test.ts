import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDirectUpload, oversizeBase64Message, uploadDirect } from "../src/assetUpload.js";

function setup(putStatus = 200, putBody = "") {
  const posts: { path: string; body: any }[] = [];
  const puts: { url: string; init: any }[] = [];
  const post = async <T,>(path: string, body?: unknown) => {
    posts.push({ path, body });
    if (path.endsWith("/upload-url")) {
      return { uploadUrl: "https://r2.example/obj?sig=1", key: "k", uploadToken: "tok", headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000" } } as T;
    }
    return { asset: { id: "a1", url: "https://cdn/x.mp4" } } as T;
  };
  const fetchFn = (async (url: string, init: any) => {
    puts.push({ url, init });
    return new Response(putBody, { status: putStatus });
  }) as unknown as typeof fetch;
  return { posts, puts, post, fetchFn };
}

test("classify: video/doc go direct, images do not", () => {
  assert.deepEqual(classifyDirectUpload("a.MOV", undefined), { type: "VIDEO", mimeType: "video/quicktime" });
  assert.deepEqual(classifyDirectUpload("a.m4v", undefined), { type: "VIDEO", mimeType: "video/x-m4v" });
  assert.deepEqual(classifyDirectUpload("a.docx", undefined)?.type, "DOCUMENT");
  assert.deepEqual(classifyDirectUpload("noext", "video/webm"), { type: "VIDEO", mimeType: "video/webm" });
  assert.equal(classifyDirectUpload("a.png", undefined), null);
  assert.equal(classifyDirectUpload("a.mp4", "image/png"), null);
});

test("video: upload-url, PUT with exact headers and no auth, complete", async () => {
  const s = setup();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const res: any = await uploadDirect({ post: s.post, fetchFn: s.fetchFn, brandId: "b1", bytes, fileName: "v.mp4", name: "Vid", tags: ["x"], type: "VIDEO", mimeType: "video/mp4" });
  assert.equal(s.posts[0].path, "/api/agent/v1/brands/b1/assets/upload-url");
  assert.deepEqual(s.posts[0].body, { name: "Vid", fileName: "v.mp4", type: "VIDEO", mimeType: "video/mp4", fileSize: 4 });
  assert.equal(s.puts[0].url, "https://r2.example/obj?sig=1");
  assert.equal(s.puts[0].init.method, "PUT");
  assert.deepEqual(s.puts[0].init.headers, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000" });
  assert.equal(s.puts[0].init.body, bytes);
  assert.equal(s.posts[1].path, "/api/agent/v1/brands/b1/assets/complete");
  assert.deepEqual(s.posts[1].body, { uploadToken: "tok", name: "Vid", tags: ["x"] });
  assert.equal(res.asset.id, "a1");
});

test("PUT failure surfaces status and body, complete never called", async () => {
  const s = setup(403, "SignatureDoesNotMatch");
  await assert.rejects(
    uploadDirect({ post: s.post, fetchFn: s.fetchFn, brandId: "b1", bytes: new Uint8Array(2), fileName: "v.mp4", type: "VIDEO", mimeType: "video/mp4" }),
    /HTTP 403 SignatureDoesNotMatch/
  );
  assert.equal(s.posts.length, 1);
});

test("oversize non-direct file fails locally", () => {
  assert.equal(oversizeBase64Message(10 * 1024 * 1024), null);
  assert.match(oversizeBase64Message(11 * 1024 * 1024)!, /10MB/);
});
