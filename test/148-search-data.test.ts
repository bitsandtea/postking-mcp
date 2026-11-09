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

import { registerSeoBriefTools } from "../src/tools/seo/briefs.js";
import { registerSeoClusterTools } from "../src/tools/seo/clusters.js";

describe("148 wave 3: brief queue", () => {
  beforeEach(() => Object.values(api).forEach((m) => m.mockReset()));

  it("seo_roadmap_create_brief POSTs the brief route", async () => {
    api.post.mockResolvedValue({ briefId: "br1", operationId: "op1", outcome: "started" });
    const res = await tool(registerSeoRoadmapTools, "seo_roadmap_create_brief").handler({ brandId: "b1", itemId: "r1" });
    expect(api.post.mock.calls[0][0]).toBe("/api/agent/v1/brands/b1/seo/roadmap/r1/brief");
    expect(JSON.parse(res.content[0].text).outcome).toBe("started");
  });

  it("seo_list_roadmap projects brief", async () => {
    api.get.mockResolvedValue({ items: [{ id: "r1", title: "T", status: "suggested", brief: { briefId: "br1", status: "pending_review", operationId: null, error: null } }] });
    const res = await tool(registerSeoRoadmapTools, "seo_list_roadmap").handler({ brandId: "b1", detail: "medium" });
    expect(JSON.parse(res.content[0].text).items[0].brief).toEqual({ briefId: "br1", status: "pending_review", operationId: null, error: null });
  });

  it("seo_get_brief surfaces kind refresh and the change plan", async () => {
    api.get.mockResolvedValue({ brief: { id: "br1", type: "blog", status: "pending_review", briefData: { kind: "refresh", pageUrl: "/blog/x", pageTitle: "X", changes: [{ action: "add", text: "Answer Q" }] } } });
    const res = await tool(registerSeoBriefTools, "seo_get_brief").handler({ brandId: "b1", briefId: "br1", detail: "medium" });
    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({ kind: "refresh", refreshPageUrl: "/blog/x", changes: [{ action: "add", text: "Answer Q" }] });
    expect(out.briefSummary).toBe("Refresh: X (1 changes)");
  });

  it("seo_list_briefs medium flags refresh briefs", async () => {
    api.get.mockResolvedValue({ briefs: [{ id: "br1", type: "blog", status: "pending_review", briefData: { kind: "refresh", pageUrl: "/blog/x" } }, { id: "br2", type: "blog", status: "approved" }] });
    const res = await tool(registerSeoBriefTools, "seo_list_briefs").handler({ brandId: "b1", detail: "medium" });
    const briefs = JSON.parse(res.content[0].text).briefs;
    expect(briefs[0]).toMatchObject({ kind: "refresh", refreshPageUrl: "/blog/x" });
    expect(briefs[1].kind).toBeNull();
  });

  it("seo_list_clusters medium includes demand", async () => {
    api.get.mockResolvedValue({ clusters: [{ id: "c1", name: "C", status: "approved", demand: { tag: "proven_demand", impressions: 900, bestPosition: 5, bestPage: "/blog/x", queryCount: 3, topQueries: [{ query: "q", impressions: 500, position: 5 }] } }, { id: "c2", name: "D", status: "approved" }] });
    const res = await tool(registerSeoClusterTools, "seo_list_clusters").handler({ brandId: "b1", detail: "medium" });
    const cl = JSON.parse(res.content[0].text).clusters;
    expect(cl[0].demand).toMatchObject({ tag: "proven_demand", impressions: 900, bestPage: "/blog/x" });
    expect(cl[1].demand).toBeUndefined();
  });
});
