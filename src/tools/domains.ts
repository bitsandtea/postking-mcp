import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

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
    "List all custom domains for the active brand, including verification status, SSL status, and what blogs or landing pages are connected to each.",
    { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/domains?brandId=${id}`);
      const domains = (data?.domains ?? (Array.isArray(data) ? data : [])).map(slimDomain);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(domains, null, 2) }],
      };
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
