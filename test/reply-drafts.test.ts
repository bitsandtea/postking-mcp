import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.js")>()),
  api,
}));
vi.mock("../src/state.js", () => ({ requireBrandId: (id?: string) => id ?? "b1" }));

import { ApiError } from "../src/client.js";
import { registerReplyDraftTools } from "../src/tools/reply-drafts.js";
import { annotationsFor } from "../src/toolAnnotations.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, Handler>();
const descriptions = new Map<string, string>();
registerReplyDraftTools({
  tool: (n: string, d: string, _s: unknown, h: Handler) => {
    tools.set(n, h);
    descriptions.set(n, d);
  },
} as unknown as McpServer);
const run = async (name: string, args: Record<string, unknown> = {}) =>
  JSON.parse((await tools.get(name)!(args)).content[0].text);

const draft = { id: "d1", status: "queued" };

describe("reply draft tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers exactly three tools (no filled/done setter)", () => {
    expect([...tools.keys()].sort()).toEqual(["reply_draft_cancel", "reply_draft_create", "reply_drafts_list"]);
  });

  it("create: description carries the contract sentence", () => {
    expect(descriptions.get("reply_draft_create")).toContain("Queues a draft. The PostKing extension fills it in the user's browser. The user posts it.");
  });

  it("create: POSTs platform/threadUrl/body to the brand route", async () => {
    api.post.mockResolvedValue({ draft });
    const args = { platform: "reddit", threadUrl: "https://www.reddit.com/r/x/comments/abc/t/", body: "hi" };
    expect(await run("reply_draft_create", args)).toMatchObject({ queued: true, humanized: false, draft });
    expect(api.post).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts", args);
  });

  it("create: humanize=true is sent and humanized is surfaced", async () => {
    api.post.mockResolvedValue({ draft, humanized: true });
    const args = { platform: "reddit", threadUrl: "https://www.reddit.com/r/x/comments/abc/t/", body: "hi" };
    expect(await run("reply_draft_create", { ...args, humanize: true })).toMatchObject({ humanized: true, draft });
    expect(api.post).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts", { ...args, humanize: true });
  });

  it("create: humanize=false is not sent", async () => {
    api.post.mockResolvedValue({ draft, humanized: false });
    const args = { platform: "reddit", threadUrl: "https://www.reddit.com/r/x/comments/abc/t/", body: "hi" };
    await run("reply_draft_create", { ...args, humanize: false });
    expect(api.post).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts", args);
  });

  it("create: description documents humanize", () => {
    expect(descriptions.get("reply_draft_create")).toContain("anti-slop + humanizer pass");
  });

  it("create: 429 surfaces the server message", async () => {
    const msg = "Daily limit reached: 10 reply drafts per brand per day. Try again tomorrow.";
    api.post.mockRejectedValue(new ApiError(429, msg));
    await expect(run("reply_draft_create", { platform: "quora", threadUrl: "https://www.quora.com/q", body: "x" })).rejects.toThrow(msg);
  });

  it("list: no filter hits the bare path", async () => {
    api.get.mockResolvedValue({ drafts: [draft] });
    expect(await run("reply_drafts_list")).toEqual({ count: 1, drafts: [draft] });
    expect(api.get).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts");
  });

  it("list: single status and limit", async () => {
    api.get.mockResolvedValue({ drafts: [] });
    await run("reply_drafts_list", { status: "queued", limit: 5 });
    expect(api.get).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts?status=queued&limit=5");
  });

  it("list: status array becomes a comma list", async () => {
    api.get.mockResolvedValue({ drafts: [] });
    await run("reply_drafts_list", { status: ["queued", "filled"] });
    expect(api.get).toHaveBeenCalledWith("/api/agent/v1/brands/b1/reply-drafts?status=queued,filled");
  });

  it("cancel: DELETEs by encoded id", async () => {
    api.delete.mockResolvedValue({ draft: { id: "a b", status: "cancelled" } });
    expect(await run("reply_draft_cancel", { draftId: "a b" })).toMatchObject({ cancelled: true });
    expect(api.delete).toHaveBeenCalledWith("/api/agent/v1/reply-drafts/a%20b");
  });

  it("annotations: cancel is destructive, list is read-only, create is a plain write", () => {
    expect(annotationsFor("reply_draft_cancel")).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(annotationsFor("reply_drafts_list")).toMatchObject({ readOnlyHint: true });
    expect(annotationsFor("reply_draft_create")).toMatchObject({ destructiveHint: false, readOnlyHint: false });
  });
});
