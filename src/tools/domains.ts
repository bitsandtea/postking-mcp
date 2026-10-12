import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../client.js";
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
    // "postking" (default) — PostKing/universal-lp serves this domain. "self_hosted" —
    // the customer's own infra serves it (see set_landing_page_distribution / the
    // self-hosted note on add_domain and verify_domain below); verification for those
    // is TXT-ownership only, no A record.
    hostingMode: d.hostingMode ?? "postking",
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
    [
      "Add a new custom domain to the active brand. After adding, call verify_domain to check DNS and activate it.",
      "hostingMode defaults to 'postking' (our infra serves it — verification checks BOTH an A record and a TXT ownership record). Pass hostingMode: 'self_hosted' when the customer's OWN infra will serve this domain — e.g. a landing page set to self_hosted distribution via set_landing_page_distribution, running against the public landing-pages API on their own server (see the example at https://github.com/bitsandtea/postking-selfhost, or any custom build). Self-hosted domains verify by TXT ownership record only — there's no A record to check, since the domain deliberately does NOT point at PostKing.",
      "Mode-match rule: when you later call connect_landing_page_domain, this Domain's hostingMode MUST match the target page's distribution ('postking' <-> 'hosted', 'self_hosted' <-> 'self_hosted') — a mismatch 409s. Set hostingMode here to match the page's distribution (or set the page's distribution to match, via set_landing_page_distribution) before connecting.",
    ].join(" "),
    {
      domain: z.string().describe("Domain name, e.g. 'myblog.com' (protocol and www stripped automatically)"),
      primaryContentType: z.enum(["landing_page", "blog"]).optional().describe("What this domain primarily serves"),
      isPrimary: z.boolean().optional().describe("Set as primary domain for the brand"),
      hostingMode: z
        .enum(["postking", "self_hosted"])
        .optional()
        .describe(
          "'postking' (default, our infra serves it) or 'self_hosted' (the customer's own infra serves it; verification is TXT-only). See tool description."
        ),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ domain, primaryContentType, isPrimary, hostingMode, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/domains`, { brandId: id, domain, primaryContentType, isPrimary, hostingMode });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimDomain(data?.domain ?? data), null, 2) }],
      };
    }
  );

  // ── Verify domain ─────────────────────────────────────────────────────────
  server.tool(
    "verify_domain",
    [
      "Check DNS verification for a domain. For a 'postking'-hostingMode domain (the default), returns whether it's pointing to PostKing servers (A record) and whether the TXT ownership record was found, plus what's still needed.",
      "For a 'self_hosted'-hostingMode domain, verification is TXT-ownership only — there's no A record to check (the domain deliberately does NOT point at PostKing). The response's `expected` DNS instructions omit the A record for these.",
    ].join(" "),
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
    "Connect a verified domain to a blog publication so articles are served from that domain. Mode-match rule: the Domain's hostingMode must match the publication's hostingMode (see set_publication_hosting_mode); a mismatch returns hosting_mode_mismatch. Supports three routingType modes: 'path' ({domain}/blog), 'root' (bare {domain}), and 'subdomain' (blog.{domain} — provisions a separate Domain row that needs its own DNS verification before it resolves).",
    {
      publicationId: z.string().describe("Blog publication ID (from list_blogs)"),
      domainId: z.string().describe("Domain ID (from list_domains) — must belong to the same brand; for 'subdomain' mode, pass the APEX domain's ID (e.g. the row for 'acme.com'), not a blog.* row."),
      routingType: z.enum(["path", "root", "subdomain"]).optional().describe(
        "How the blog is routed on the domain: " +
          "'path' serves it at {domain}/blog (or a custom pathPrefix); " +
          "'root' serves it at the bare domain root (the domain must not already have a landing page connected — 409 if it does); " +
          "'subdomain' serves it at blog.{domain} — this creates (or reuses) a separate 'blog.<domain>' Domain row that needs its OWN DNS verification (a CNAME/A record for the 'blog' host) before it resolves; call add_domain/verify_domain again for that new row after connecting."
      ),
      pathPrefix: z.string().optional().describe("Path prefix if routingType is 'path', e.g. '/blog'"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, domainId, routingType, pathPrefix, brandId }) => {
      const id = requireBrandId(brandId);
      try {
        const data = await api.patch<any>(`/api/agent/v1/brands/${id}/publications/${publicationId}`, {
          domainId,
          routingType,
          pathPrefix,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "hosting_mode_mismatch",
                  message:
                    (err.message || "This domain's hostingMode doesn't match the publication's hostingMode.") +
                    " Call set_publication_hosting_mode to switch the publication's hostingMode to match this domain's hostingMode, or add_domain with a hostingMode that matches the publication's current hostingMode, then retry connect_domain_to_publication.",
                }),
              },
            ],
          };
        }
        throw err;
      }
    }
  );
}
