import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";

/**
 * Source link policy — which sites SEO articles may link to / cite.
 *
 * "Primary sources" = original publishers of the facts: government and
 * regulator sites, universities and journals, original-research publishers,
 * standards bodies, a major platform's own docs/help/legal pages, and the
 * brand's own pages. Competitors, other tool vendors, marketplaces, user
 * posts (e.g. LinkedIn Pulse) and video sites are not primary sources.
 *
 * Default is ON. The brand's registered competitors are always blocked.
 * Changing the setting affects FUTURE briefs, articles and refreshes only —
 * already-written articles are not rewritten.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const PRIMARY_DEF =
  "\"Primary sources\" means the original publishers of a fact: government/regulator sites, universities " +
  "and journals, original-research publishers, standards bodies, a major platform's own docs/help/legal " +
  "pages, and the brand's own pages — never competitors, other vendors, marketplaces, user posts or video sites.";

export function registerSeoSourcePolicyTools(server: McpServer) {
  server.tool(
    "seo_get_source_policy",
    [
      "Read-only. Returns the brand's source link policy: { policy: { primarySourcesOnly, allowDomains, blockDomains }, competitorDomains }.",
      "Pass `url` (a full http(s) link) to instead ask \"would this link be allowed in this brand's articles?\" — returns { url, allowed, reason, host } where `reason` says why (government, academic, own, allowlisted, blocklisted, competitor, vendor, ugc, video, ...).",
      PRIMARY_DEF,
      "`allowDomains` are always allowed, `blockDomains` are never linked (and win over the allowlist); " +
        "`competitorDomains` (the brand's registered competitors) are always blocked regardless.",
      "Requires a paid plan.",
    ].join(" "),
    {
      url: z.string().optional().describe("Optional full http(s) URL: check this one link against the policy instead of reading the settings."),
      brandId: brandOpt,
    },
    async ({ url, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = url ? `?url=${encodeURIComponent(url)}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/seo/source-policy${qs}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "seo_set_source_policy",
    [
      "Update the brand's source link policy. Pass only the fields you want to change; omitted fields keep their current value.",
      PRIMARY_DEF,
      "`primarySourcesOnly` (default true) turns the policy on/off. `allowDomains` / `blockDomains` REPLACE the " +
        "whole list (read first with seo_get_source_policy to add or remove one entry); entries may be bare domains " +
        "or pasted URLs (max 500 each, subdomains match). `blockDomains` wins over `allowDomains`.",
      "Invalid entries are rejected with HTTP 400 naming each one.",
      "This affects FUTURE briefs, articles and refreshes only; existing articles are not rewritten.",
      "Requires a paid plan. Returns { ok, policy, competitorDomains }.",
    ].join(" "),
    {
      primarySourcesOnly: z.boolean().optional().describe("true = only link primary sources (default); false = any source not otherwise blocked."),
      allowDomains: z.array(z.string()).max(500).optional().describe("Always-allow domains/URLs. Replaces the list."),
      blockDomains: z.array(z.string()).max(500).optional().describe("Never-link domains/URLs. Replaces the list; wins over allowDomains."),
      brandId: brandOpt,
    },
    async ({ primarySourcesOnly, allowDomains, blockDomains, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (primarySourcesOnly !== undefined) body.primarySourcesOnly = primarySourcesOnly;
      if (allowDomains !== undefined) body.allowDomains = allowDomains;
      if (blockDomains !== undefined) body.blockDomains = blockDomains;
      const data = await api.put<unknown>(`/api/agent/v1/brands/${id}/seo/source-policy`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
