import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const patch = vi.hoisted(() => vi.fn());
vi.mock("../src/client.js", () => ({ api: { patch } }));

import { registerPostTools } from "../src/tools/posts.js";

type Handler = (args: { postId: string; content: string }) => Promise<{ content: { text: string }[] }>;
type Shape = { content: { safeParse: (v: unknown) => { success: boolean } } };

function getTool() {
  const tools = new Map<string, { description: string; shape: Shape; handler: Handler }>();
  const server = {
    tool: (name: string, description: string, shape: Shape, handler: Handler) => {
      tools.set(name, { description, shape, handler });
    },
  } as unknown as McpServer;
  registerPostTools(server);
  return tools.get("update_post")!;
}

describe("update_post", () => {
  beforeEach(() => {
    patch.mockReset();
  });

  it("PATCHes only { content } and builds the confirmation from the response", async () => {
    patch.mockResolvedValue({
      success: true,
      post: { id: "p1", status: "scheduled", content: "new text", postAt: "2026-12-01T09:00:00Z" },
      webUrl: "https://postking.app/p1",
    });

    const res = await getTool().handler({ postId: "p1", content: "new text" });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/agent/v1/posts/p1", { content: "new text" });
    expect(JSON.parse(res.content[0].text)).toEqual({
      postId: "p1",
      status: "scheduled",
      content: "new text",
      scheduledAt: "2026-12-01T09:00:00Z",
      webUrl: "https://postking.app/p1",
    });
  });

  it("omits schedule and link fields the response doesn't have", async () => {
    patch.mockResolvedValue({ post: { id: "p2", status: "created", content: "draft" } });

    const res = await getTool().handler({ postId: "p2", content: "draft" });

    expect(JSON.parse(res.content[0].text)).toEqual({ postId: "p2", status: "created", content: "draft" });
  });

  it("surfaces the API's rejection of an already-posted post", async () => {
    patch.mockRejectedValue(new Error("Cannot update post with status posted"));

    await expect(getTool().handler({ postId: "p3", content: "x" })).rejects.toThrow(/status posted/);
  });

  it("rejects empty content in the param schema", () => {
    const { shape } = getTool();
    expect(shape.content.safeParse("").success).toBe(false);
    expect(shape.content.safeParse("text").success).toBe(true);
  });
});
