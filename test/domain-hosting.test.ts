import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock("../src/client.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/client.js")>();
  return { ...actual, api: { post, put } };
});
vi.mock("../src/state.js", () => ({ requireBrandId: (id?: string) => id ?? "b1" }));

import { registerDomainTools } from "../src/tools/domains.js";
import { ApiError } from "../src/client.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function tools() {
  const map = new Map<string, { description: string; handler: Handler }>();
  const server = {
    tool: (name: string, description: string, _shape: unknown, handler: Handler) => {
      map.set(name, { description, handler });
    },
  } as unknown as McpServer;
  registerDomainTools(server);
  return map;
}

describe("switch_domain_hosting_mode", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("tells the model to dry-run first and that nothing is disconnected", () => {
    const d = tools().get("switch_domain_hosting_mode")!.description;
    expect(d).toMatch(/dryRun: true/);
    expect(d).toMatch(/NEVER disconnects/);
  });

  it("POSTs hostingMode + dryRun to the domain's hosting-mode route and returns the body", async () => {
    post.mockResolvedValue({ dryRun: true, domainId: "d1", hostingMode: "self_hosted", changes: { domain: null, landingPages: [], blogs: [] } });
    const res = await tools().get("switch_domain_hosting_mode")!.handler({ domainId: "d1", hostingMode: "self_hosted", dryRun: true });
    expect(post).toHaveBeenCalledWith("/api/agent/v1/domains/d1/hosting-mode", { hostingMode: "self_hosted", dryRun: true });
    expect(JSON.parse(res.content[0].text).dryRun).toBe(true);
  });

  it("turns 409 domain_not_verified into an actionable message", async () => {
    const err = new ApiError(409, "Domain is not verified", { code: "domain_not_verified" });
    post.mockReturnValue(Promise.reject(err));
    const res = await tools().get("switch_domain_hosting_mode")!.handler({ domainId: "d1", hostingMode: "postking" });
    const out = JSON.parse(res.content[0].text);
    expect(out.error).toBe("domain_not_verified");
    expect(out.message).toMatch(/verify_domain/);
  });
});

describe("set_domain_revalidate_secret", () => {
  beforeEach(() => {
    put.mockReset();
  });

  it("sets the secret and never echoes it back", async () => {
    const secret = "s3cret-value-0123456789";
    put.mockResolvedValue({ domain: { id: "d1", domain: "a.com", hasRevalidateSecret: true } });
    const res = await tools().get("set_domain_revalidate_secret")!.handler({ domainId: "d1", secret });
    expect(put).toHaveBeenCalledWith("/api/agent/v1/domains/d1", { revalidateSecret: secret });
    expect(res.content[0].text).not.toContain(secret);
    expect(JSON.parse(res.content[0].text)).toEqual({ domainId: "d1", domain: "a.com", hasRevalidateSecret: true });
  });

  it("clears with null", async () => {
    put.mockResolvedValue({ domain: { id: "d1", domain: "a.com", hasRevalidateSecret: false } });
    await tools().get("set_domain_revalidate_secret")!.handler({ domainId: "d1", clear: true });
    expect(put).toHaveBeenCalledWith("/api/agent/v1/domains/d1", { revalidateSecret: null });
  });

  it("rejects neither / both of secret and clear without calling the API", async () => {
    const t = tools().get("set_domain_revalidate_secret")!;
    await t.handler({ domainId: "d1" });
    await t.handler({ domainId: "d1", secret: "x".repeat(20), clear: true });
    expect(put).not.toHaveBeenCalled();
  });
});
