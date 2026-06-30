import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";

function slimDomain(d: any) {
  return {
    id: d.id,
    domain: d.domain,
    isVerified: d.isVerified,
    isPrimary: d.isPrimary,
    sslStatus: d.sslStatus,
    primaryContentType: d.primaryContentType,
    connectedBlogs: (d.blogs ?? []).map((b: any) => ({ id: b.id, title: b.title, routingType: b.routingType, pathPrefix: b.pathPrefix })),
    connectedLandingPages: (d.landingPages ?? []).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status })),
  };
}

export function registerDomainTools(server: McpServer) {
  // ── List domains ──────────────────────────────────────────────────────────
  server.tool(
    "list_domains",
    "List all custom domains for the active brand. Lists default short; pass detail=medium/full for more fields including SSL status, verification, and connected blogs or landing pages.",
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("short"),
    },
    async ({ brandId, detail }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/domains?brandId=${id}`);
      const raw = (data as any)?.domains ?? (Array.isArray(data) ? data : []);
      const proj: Projector<unknown> = {
        short: (d) => ({
          id: (d as any).id,
          domain: (d as any).domain,
          status: (d as any).sslStatus ?? ((d as any).isVerified ? "verified" : "pending"),
        }),
        medium: (d) => slimDomain(d as any),
      };
      const text = JSON.stringify({ count: raw.length, detail, domains: projectList(detail, raw, proj) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Add domain ────────────────────────────────────────────────────────────
  server.tool(
    "add_domain",
    "Add a new custom domain to the active brand. After adding, call verify_domain to check DNS and activate it.",
    {
      domain: z.string().describe("Domain name, e.g. 'myblog.com' (protocol and www stripped automatically)"),
      primaryContentType: z.enum(["landing_page", "blog"]).optional().describe("What this domain primarily serves"),
      isPrimary: z.boolean().optional().describe("Set as primary domain for the brand"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ domain, primaryContentType, isPrimary, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/domains`, { brandId: id, domain, primaryContentType, isPrimary });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimDomain(data?.domain ?? data), null, 2) }],
      };
    }
  );

  // ── Verify domain ─────────────────────────────────────────────────────────
  server.tool(
    "verify_domain",
    "Check DNS verification for a domain. Returns whether it's pointing to PostKing servers and what A record is needed if not.",
    { domainId: z.string().describe("Domain ID to verify (from list_domains)") },
    async ({ domainId }) => {
      const data = await api.post<any>(`/api/agent/v1/domains/${domainId}/verify`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Delete domain ─────────────────────────────────────────────────────────
  server.tool(
    "delete_domain",
    "Remove a custom domain. Connected blogs and landing pages are unlinked but not deleted.",
    { domainId: z.string().describe("Domain ID to delete (from list_domains)") },
    async ({ domainId }) => {
      await api.delete<any>(`/api/agent/v1/domains/${domainId}`);
      return {
        content: [{ type: "text" as const, text: `Domain ${domainId} deleted.` }],
      };
    }
  );

  // ── Connect blog to publication ───────────────────────────────────────────
  server.tool(
    "connect_domain_to_publication",
    "Connect a verified domain to a blog publication so articles are served from that domain.",
    {
      publicationId: z.string().describe("Blog publication ID (from list_blogs)"),
      domainId: z.string().describe("Domain ID (from list_domains)"),
      routingType: z.enum(["subdomain", "path"]).optional().describe("How the blog is routed on the domain"),
      pathPrefix: z.string().optional().describe("Path prefix if routingType is 'path', e.g. '/blog'"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, domainId, routingType, pathPrefix, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/publications/${publicationId}`, {
        domainId,
        routingType,
        pathPrefix,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
