import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.js")>()),
  api,
}));

import { registerBlogTools } from "../src/tools/blog.js";
import { registerBrandTools } from "../src/tools/brand.js";
import { registerLpTools } from "../src/tools/lp.js";

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

describe("149 page schema types", () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.get.mockResolvedValue({});
    api.put.mockResolvedValue({});
    api.patch.mockResolvedValue({});
  });

  it("edit_side_page forwards authorId and hideAuthor", async () => {
    await tool(registerLpTools, "edit_side_page")({ slug: "lp", sideKey: "vs-x", authorId: null, hideAuthor: true });
    expect(api.patch).toHaveBeenCalledWith("/api/agent/v1/landing-pages/lp/side-pages/vs-x", { authorId: null, hideAuthor: true });
  });

  it("set_side_page_author_defaults PUTs only the given kinds", async () => {
    await tool(registerBlogTools, "set_side_page_author_defaults")({ comparison: "none", brandId: "b1" });
    expect(api.put).toHaveBeenCalledWith("/api/agent/v1/brands/b1/authors/side-page-defaults", { comparison: "none" });
  });

  it("get_business_type GETs the offering", async () => {
    await tool(registerBrandTools, "get_business_type")({ brandId: "b1" });
    expect(api.get).toHaveBeenCalledWith("/api/agent/v1/brands/b1/schema-offering");
  });

  it("set_business_type sends kind or reset", async () => {
    const h = tool(registerBrandTools, "set_business_type");
    await h({ kind: "local_business", schemaType: "HairSalon", brandId: "b1" });
    expect(api.put).toHaveBeenLastCalledWith("/api/agent/v1/brands/b1/schema-offering", { kind: "local_business", schemaType: "HairSalon" });
    await h({ reset: true, brandId: "b1" });
    expect(api.put).toHaveBeenLastCalledWith("/api/agent/v1/brands/b1/schema-offering", { reset: true });
  });
});
