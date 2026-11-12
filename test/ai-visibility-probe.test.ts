import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.js")>()),
  api,
}));
vi.mock("../src/state.js", () => ({ requireBrandId: (id?: string) => id ?? "b1" }));

import { ApiError } from "../src/client.js";
import { registerAiVisibilityProbeTools } from "../src/tools/ai-visibility-probe.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, Handler>();
registerAiVisibilityProbeTools({
  tool: (n: string, _d: string, _s: unknown, h: Handler) => void tools.set(n, h),
} as unknown as McpServer);
const run = async (name: string, args: Record<string, unknown> = {}) =>
  JSON.parse((await tools.get(name)!(args)).content[0].text);

describe("ai visibility probe tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers the six tools", () => {
    expect([...tools.keys()].sort()).toEqual([
      "ai_visibility_run",
      "ai_visibility_run_status",
      "ai_visibility_topic_add",
      "ai_visibility_topic_include",
      "ai_visibility_topic_remove",
      "ai_visibility_topics_list",
    ]);
  });

  it("run: success posts to /run and reports started", async () => {
    api.get.mockResolvedValue({ topics: { candidates: [], selectedTopicIds: [] } });
    api.post.mockResolvedValue({ success: true, runsStarted: 2 });
    const res = await run("ai_visibility_run");
    expect(api.post).toHaveBeenCalledWith("/api/agent/v1/brands/b1/search-performance/ai-visibility/run");
    expect(res).toMatchObject({ started: true, runsStarted: 2 });
  });

  it("run: warns about custom topics that are not in the run yet", async () => {
    api.get.mockResolvedValue({
      topics: {
        candidates: [
          { id: "seo", label: "s", description: "d" },
          { id: "custom-new", label: "n", description: "d" },
        ],
        selectedTopicIds: ["seo"],
      },
    });
    api.post.mockResolvedValue({ success: true, runsStarted: 1 });
    const res = await run("ai_visibility_run");
    expect(res.topicsNotInRun).toEqual(["custom-new"]);
    expect(res.warning).toContain("ai_visibility_topic_include");
  });

  it("include: posts topicIds, reports questionsPending, maps refusals", async () => {
    api.post.mockResolvedValueOnce({ success: true, started: ["custom-a"], alreadyIncluded: [], questionsPending: true });
    expect(await run("ai_visibility_topic_include", { topicIds: ["custom-a"] })).toMatchObject({
      included: true,
      started: ["custom-a"],
      questionsPending: true,
    });
    expect(api.post).toHaveBeenLastCalledWith("/api/agent/v1/brands/b1/search-performance/ai-visibility/topics/include", {
      topicIds: ["custom-a"],
    });
    api.post.mockRejectedValueOnce(new ApiError(409, "running: busy"));
    expect(await run("ai_visibility_topic_include", { topicIds: ["x"] })).toMatchObject({ included: false, refusal: "running" });
    api.post.mockRejectedValueOnce(new ApiError(409, "no_config: set up first"));
    expect(await run("ai_visibility_topic_include", { topicIds: ["x"] })).toMatchObject({ refusal: "no_config" });
    api.post.mockRejectedValueOnce(new ApiError(404, "Unknown topic(s): x."));
    expect(await run("ai_visibility_topic_include", { topicIds: ["x"] })).toMatchObject({ refusal: "unknown_topic" });
  });

  it.each(["running", "no_config", "monthly_limit"])("run: 409 %s becomes a structured refusal", async (token) => {
    api.post.mockRejectedValue(new ApiError(409, `${token}: whatever`));
    expect(await run("ai_visibility_run")).toMatchObject({ started: false, refusal: token });
  });

  it("run: 403 becomes tier_upgrade_required; other errors still throw", async () => {
    api.post.mockRejectedValueOnce(new ApiError(403, "The Deep AI Dive is available on Pro and Enterprise."));
    expect(await run("ai_visibility_run")).toMatchObject({ started: false, refusal: "tier_upgrade_required" });
    api.post.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(run("ai_visibility_run")).rejects.toThrow("boom");
  });

  it("run_status: flags idle when nothing is running", async () => {
    api.get.mockResolvedValue({ operationStatus: { status: "failed", error: "No check found for this brand." } });
    expect(await run("ai_visibility_run_status")).toMatchObject({ idle: true });
  });

  it("topics_list: marks selected and custom, and reports drafting in progress", async () => {
    api.get.mockImplementation(async (path: string) =>
      path.endsWith("/run-status")
        ? { operationStatus: { status: "processing" } }
        : {
            topics: {
              candidates: [
                { id: "seo", label: "SEO", description: "d" },
                { id: "custom-x", label: "X", description: "d" },
              ],
              selectedTopicIds: ["seo"],
            },
          }
    );
    const res = await run("ai_visibility_topics_list");
    expect(res.inProgress).toBe(true);
    expect(res.topics).toEqual([
      expect.objectContaining({ id: "seo", selected: true, custom: false }),
      expect.objectContaining({ id: "custom-x", selected: false, custom: true }),
    ]);
  });

  it("topic_add posts the body; topic_remove deletes by encoded id and maps refusals", async () => {
    api.post.mockResolvedValue({ topics: { candidates: [] }, addedTopicId: "custom-a" });
    expect(await run("ai_visibility_topic_add", { label: "A" })).toMatchObject({ added: true, addedTopicId: "custom-a" });
    expect(api.post).toHaveBeenCalledWith("/api/agent/v1/brands/b1/search-performance/ai-visibility/topics", { label: "A" });

    api.delete.mockResolvedValueOnce({ topics: { candidates: [] }, removedFromRuns: true });
    expect(await run("ai_visibility_topic_remove", { topicId: "a b" })).toMatchObject({ removed: true, removedFromRuns: true });
    expect(api.delete).toHaveBeenCalledWith("/api/agent/v1/brands/b1/search-performance/ai-visibility/topics/a%20b");

    api.delete.mockRejectedValueOnce(new ApiError(409, "only topic"));
    expect(await run("ai_visibility_topic_remove", { topicId: "seo" })).toMatchObject({ removed: false, message: "only topic" });
  });
});
