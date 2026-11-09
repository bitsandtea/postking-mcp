import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.js")>()),
  api,
}));

import { registerSeoRoadmapTools } from "../src/tools/seo/roadmap.js";
import { registerSeoSearchDataTools } from "../src/tools/seo/search-data.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function tool(register: (s: McpServer) => void, name: string): { handler: Handler; schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } {
  const tools = new Map<string, { handler: Handler; schema: never }>();
  register({
    tool: (n: string, _d: string, schema: never, h: Handler) => {
      tools.set(n, { handler: h, schema });
    },
  } as unknown as McpServer);
  return tools.get(name)!;
}

describe("148 search-data tools", () => {
  beforeEach(() => Object.values(api).forEach((m) => m.mockReset()));

  it("seo_search_data_status GETs the status route", async () => {
    api.get.mockResolvedValue({ connected: true, reconcile: null });
    const res = await tool(registerSeoSearchDataTools, "seo_search_data_status").handler({ brandId: "b1" });
    expect(api.get).toHaveBeenCalledWith("/api/agent/v1/brands/b1/seo/search-data");
    expect(JSON.parse(res.content[0].text).connected).toBe(true);
  });

  it("seo_search_data_reconcile POSTs the reconcile route", async () => {
    api.post.mockResolvedValue({ success: true });
    await tool(registerSeoSearchDataTools, "seo_search_data_reconcile").handler({ brandId: "b1" });
    expect(api.post.mock.calls[0][0]).toBe("/api/agent/v1/brands/b1/seo/search-data/reconcile");
  });

  it("seo_list_roadmap sends type + status filters and projects search fields", async () => {
    api.get.mockResolvedValue({
      items: [{
        id: "r1", title: "Refresh: X", status: "ignored", itemType: "refresh", priority: "high",
        metadata: { hiddenReason: "ranks_top3", searchEvidence: { impressions: 900, position: 2.1, bucket: "covered" }, refresh: { pageUrl: "/blog/x" }, userOverride: { pinned: true } },
      }],
    });
    const res = await tool(registerSeoRoadmapTools, "seo_list_roadmap").handler({ brandId: "b1", status: "ignored", type: "refresh", detail: "medium" });
    expect(api.get.mock.calls[0][0]).toBe("/api/agent/v1/brands/b1/seo/roadmap?status=ignored&type=refresh");
    const item = JSON.parse(res.content[0].text).items[0];
    expect(item).toMatchObject({ type: "refresh", priority: "high", hiddenReason: "ranks_top3", refreshPageUrl: "/blog/x", userOverride: { pinned: true } });
    expect(item.searchEvidence).toEqual({ impressions: 900, position: 2.1, bucket: "covered" });
  });

  it("seo_roadmap_edit accepts the new actions and forwards them", async () => {
    api.patch.mockResolvedValue({ success: true });
    const t = tool(registerSeoRoadmapTools, "seo_roadmap_edit");
    for (const action of ["restore", "pin", "unpin", "remove", "start"]) {
      expect(t.schema.action.safeParse(action).success).toBe(true);
    }
    await t.handler({ brandId: "b1", itemId: "r1", action: "pin" });
    expect(api.patch).toHaveBeenCalledWith("/api/agent/v1/brands/b1/seo/roadmap/r1", { action: "pin" });
  });
});
