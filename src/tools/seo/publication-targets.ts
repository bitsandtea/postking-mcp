import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";

/**
 * SEO Publication Targeting. A brand can have several blog publications, even
 * several in the same content language (see list_publications /
 * get_brand_languages). This tells the agent which publication SEO article
 * generation (seo_write_article, and the auto-fired writes behind
 * seo_approve_briefs) will file each language's articles into, and lets it
 * pin that choice per language instead of relying on the implicit default.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

export function registerSeoPublicationTargetTools(server: McpServer) {
  // ── Read current publication targets ────────────────────────────────────
  server.tool(
    "seo_get_publication_targets",
    [
      "Read-only. Returns, per enabled brand content language, which blog publication SEO article " +
        "generation (seo_write_article) will file that language's articles into.",
      "Returns { targets }. `targets` is an array with one entry per enabled brand content language " +
        "(default language first): { languageCode, source: \"explicit\"|\"auto\"|\"none\", publication, " +
        "candidates }. `publication` (and each entry in `candidates`) is { id, title, languageCode, " +
        "publicUrl, articleCount } or null.",
      "`source` explains how `publication` was picked: \"explicit\" means the user pinned it (via " +
        "seo_set_publication_target); \"auto\" means it's the first publication in that language by " +
        "creation date — the implicit default when nothing is pinned; \"none\" means there is no " +
        "publication in that language yet — one is auto-created the first time an article is written.",
      "`candidates` lists every publication the brand has in that language (including the current " +
        "`publication`), so you can see what else is available before pinning a different one.",
      "Call this before seo_write_article whenever a brand has 2+ publications, and show the user the " +
        "publication's title + publicUrl so they know where the article will land.",
    ].join(" "),
    {
      brandId: brandOpt,
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/seo/publication-targets`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set a publication target ────────────────────────────────────────────
  server.tool(
    "seo_set_publication_target",
    [
      "Pin which blog publication SEO article generation (seo_write_article) files a given content " +
        "language's articles into, overriding the implicit \"auto\" default (first publication in that " +
        "language by creation date). Pass `publicationId: null` to unpin and return to automatic.",
      "`languageCode` is a content-language code such as \"en\" or \"pt-BR\" — NOT the DataForSEO market " +
        "code used by seo_set_market_settings — and must already be one of the brand's enabled languages " +
        "(see get_brand_languages).",
      "The publication's own languageCode must match `languageCode`, or the server rejects the call with " +
        "HTTP 400 — an article inherits its language from its publication, so a mismatch would misfile it. " +
        "Get candidate publication ids from list_publications or from the `candidates` array in " +
        "seo_get_publication_targets.",
      "Returns 404 if `publicationId` doesn't belong to this brand.",
      "This only affects FUTURE SEO-generated articles. To move an already-written article, use " +
        "update_blog_article with its `publicationId` param instead. To create a new publication first, " +
        "use create_publication.",
      "Returns { ok, target }.",
    ].join(" "),
    {
      languageCode: z
        .string()
        .min(2)
        .describe(
          "Content-language code, e.g. \"en\", \"pt-BR\" (NOT a DataForSEO market code). Must be one of " +
            "the brand's enabled languages — check with get_brand_languages."
        ),
      publicationId: z
        .string()
        .min(1)
        .nullable()
        .describe(
          "Publication id to pin for this language, from list_publications or the `candidates` array in " +
            "seo_get_publication_targets. Pass null to unpin and revert to automatic (first publication in " +
            "that language by creation date)."
        ),
      brandId: brandOpt,
    },
    async ({ languageCode, publicationId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.put<unknown>(`/api/agent/v1/brands/${id}/seo/publication-targets`, {
        languageCode,
        publicationId,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
