import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.js")>()),
  api,
}));

import { registerBlogTools } from "../src/tools/blog.js";
import { registerPostTools } from "../src/tools/posts.js";
import { registerRedditTools } from "../src/tools/reddit.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function tool(register: (s: McpServer) => void, name: string): Handler {
  const tools = new Map<string, Handler>();
  register({
    tool: (n: string, _d: string, _s: unknown, h: Handler) => {
      tools.set(n, h);
    },
  } as unknown as McpServer);
  return tools.get(name)!;
}

describe("params the server accepts reach the request", () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
  });

  it("list_blogs sends offset and points at the next page", async () => {
    api.get.mockResolvedValue({
      publications: [],
      blogs: [{ id: "a3", status: "draft" }],
      pagination: { total: 5 },
    });

    const res = await tool(registerBlogTools, "list_blogs")({ brandId: "b", detail: "short", limit: 1, offset: 2 });

    const url = new URL(api.get.mock.calls[0][0] as string, "https://x");
    expect(url.searchParams.get("offset")).toBe("2");
    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({ count: 1, total: 5, offset: 2, truncated: true });
    expect(out.note).toContain("offset=3");
  });

  it("list_blogs is not truncated on the last page", async () => {
    api.get.mockResolvedValue({
      publications: [],
      blogs: [{ id: "a5", status: "draft" }],
      pagination: { total: 5 },
    });

    const res = await tool(registerBlogTools, "list_blogs")({ brandId: "b", detail: "short", limit: 1, offset: 4 });

    const out = JSON.parse(res.content[0].text);
    expect(out.truncated).toBe(false);
    expect(out.note).toBeUndefined();
  });

  it("list_blogs pages locally when the backend ignores offset", async () => {
    api.get.mockResolvedValue({
      publications: [],
      blogs: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
    });

    const res = await tool(registerBlogTools, "list_blogs")({ brandId: "b", detail: "short", limit: 1, offset: 1 });

    const out = JSON.parse(res.content[0].text);
    expect(out.articles.map((a: { id: string }) => a.id)).toEqual(["a2"]);
    expect(out.truncated).toBe(true);
  });

  it("reply_to_x_post forwards postingAccountId", async () => {
    api.post.mockResolvedValue({ post: { id: "p1", status: "posted" } });

    await tool(registerPostTools, "reply_to_x_post")({ brandId: "b", replyTo: "1", content: "hi", postingAccountId: "acc1" });

    expect(api.post.mock.calls[0][0]).toBe("/api/agent/v1/brands/b/posts/x-reply");
    expect(api.post.mock.calls[0][1]).toMatchObject({ postingAccountId: "acc1" });
  });

  it("reddit_rewrite forwards founderContext", async () => {
    // Rejecting stops the handler before its polling loop; only the body matters here.
    api.post.mockRejectedValue(new Error("stop"));

    await expect(
      tool(registerRedditTools, "reddit_rewrite")({ brandId: "b", subreddit: "saas", sourceContent: "x", founderContext: "I sold it for $2M" }),
    ).rejects.toThrow("stop");

    expect(api.post.mock.calls[0][1]).toMatchObject({ founderContext: "I sold it for $2M" });
  });
});
