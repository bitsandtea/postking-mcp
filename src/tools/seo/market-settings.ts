import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";

/**
 * SEO Market/Language Targeting (feature 96, widened to v2 multi-language by
 * feature 104/110). Configures which (location, language) SEO markets a
 * brand's keyword research pulls from — the missing prerequisite step ahead
 * of seo_estimate_research_cost / seo_generate_keywords.
 *
 * A "market" is a `(location, language)` pair, e.g. Germany + German. This is
 * NOT the same thing as PostKing's content-language field (`en`, `pt-BR`,
 * etc. — see src/languages.ts): the `languageCode` on a market is in
 * DataForSEO's vocabulary, which has no `pt-BR` — Brazil is location 2076 +
 * language "pt". If you're holding a content-language code and need the
 * matching market language, map it: en->en, es->es, pt-BR->pt, de->de,
 * fr->fr (the main app keeps this mapping as
 * CONTENT_LANGUAGE_TO_DATAFORSEO_LANGUAGE in src/const/languages.ts).
 *
 * Only a curated set of (location, language) pairs is accepted by the
 * server today — anything else is rejected:
 *   Germany   2276 / "de"
 *   France    2250 / "fr"
 *   Spain     2724 / "es"
 *   Brazil    2076 / "pt"
 *   US        2840 / "en"
 *
 * Flow: seo_set_market_settings (configure markets) -> seo_estimate_research_cost
 * (language) -> seo_generate_keywords (language). seo_estimate_research_cost
 * already tells the agent when a language has zero configured markets; this
 * is how the agent fixes that.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const seoMarketObject = z.object({
  locationCode: z
    .number()
    .describe("DataForSEO location_code, e.g. 2276 for Germany, 2840 for the US."),
  countryCode: z.string().min(1).describe("ISO 3166-1 alpha-2, uppercase, e.g. \"DE\", \"US\"."),
  label: z.string().min(1).describe("Display label for this market, e.g. \"Germany\", \"United States\"."),
  languageCode: z
    .string()
    .min(1)
    .describe(
      "DataForSEO language code for this pair, e.g. \"de\", \"fr\", \"pt\" — NOT a content-language " +
        "code (no \"pt-BR\" here; Brazil is locationCode 2076 + languageCode \"pt\"). Must match one of " +
        "the curated (location, language) pairs the server accepts: Germany 2276/\"de\", France 2250/\"fr\", " +
        "Spain 2724/\"es\", Brazil 2076/\"pt\", US 2840/\"en\". Any other pair is rejected."
    ),
});

export function registerSeoMarketSettingsTools(server: McpServer) {
  // ── Read current market settings ──────────────────────────────────────────
  server.tool(
    "seo_get_market_settings",
    [
      "Read-only. Returns the brand's currently configured SEO markets (the (location, language) pairs " +
        "keyword research pulls from) plus the resolved view after applying the Global default.",
      "Returns { settings, resolved }. `settings` is null if the brand has never configured markets " +
        "(resolves to Global — a single US/en pull). `resolved` is always concrete: { isGlobal, markets }.",
      "Call this before seo_estimate_research_cost / seo_generate_keywords with a `language` the brand " +
        "may not have a market for yet, or before seo_set_market_settings to see what's already configured.",
      "Requires a paid plan — a free/trial key gets a payment-required error back; surface that to the " +
        "user rather than retrying.",
    ].join(" "),
    {
      brandId: brandOpt,
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/seo/market-settings`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set market settings ───────────────────────────────────────────────────
  server.tool(
    "seo_set_market_settings",
    [
      "Configure the brand's SEO markets — the (location, language) pairs keyword research " +
        "(seo_generate_keywords) pulls from. This is the step seo_estimate_research_cost is telling " +
        "the agent to do when it reports pairCount 0 for a language.",
      "Pass `markets: \"global\"` to explicitly revert to the default (a single US/en pull) — this is " +
        "distinct from the brand never having configured markets, though both resolve the same way.",
      "Otherwise pass `markets` as an array of 1-3 (location, language) pairs from the curated set: " +
        "Germany 2276/\"de\", France 2250/\"fr\", Spain 2724/\"es\", Brazil 2076/\"pt\", US 2840/\"en\". " +
        "Any pair outside this curated list is rejected.",
      "`languageCode` on each market is DataForSEO's vocabulary, not PostKing's content-language codes — " +
        "there is no \"pt-BR\"; Brazil is locationCode 2076 + languageCode \"pt\". Map a content language " +
        "to its market language with: en->en, es->es, pt-BR->pt, de->de, fr->fr.",
      "Two SEPARATE tier caps apply: the number of (location, language) PAIRS is capped at 1-3 depending " +
        "on plan, while the number of DISTINCT LANGUAGES across those pairs is capped separately " +
        "(Trial/Growth 1, Pro 2, Enterprise 5). A brand can target 3 English-language markets on one " +
        "plan tier, or 2 markets spanning 2 different languages on a higher tier — check the error message " +
        "if a call is rejected for exceeding a cap.",
      "Requires a paid plan — a free/trial key gets a payment-required error back; surface that to the " +
        "user rather than retrying.",
      "Returns { ok, marketsChanged, resolved }. After this, call seo_estimate_research_cost(language) to " +
        "see the cost for a newly-configured language, then seo_generate_keywords(language) to run it.",
    ].join(" "),
    {
      markets: z
        .union([z.literal("global"), z.array(seoMarketObject).min(1).max(3)])
        .describe(
          "\"global\" to revert to the default (single US/en pull), or 1-3 curated (location, language) pairs."
        ),
      brandId: brandOpt,
    },
    async ({ markets, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.put<unknown>(`/api/agent/v1/brands/${id}/seo/market-settings`, {
        markets,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
