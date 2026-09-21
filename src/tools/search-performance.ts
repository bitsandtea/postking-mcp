import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList } from "../detail.js";
import { brandDashboardUrl } from "../links.js";
import {
  AI_VISIBILITY_SECTIONS,
  SEARCH_PERFORMANCE_SECTIONS,
  aiCitationQueryProj,
  asObj,
  asRows,
  shapeAiVisibility,
  shapeSearchPerformance,
  sourceProj,
  worklistProj,
} from "./search-performance-shape.js";

/**
 * Search Performance + AI Visibility — read-only reporting surface over the
 * Search Console / Bing Webmaster / GA4 connectors and the Deep AI Dive
 * (GEO visibility) engine. Every tool here proxies an existing dashboard
 * read model (PostKing's `src/services/search-performance/**`,
 * `src/services/geo-visibility/**`) via `/api/agent/v1/brands/{id}/...` — no
 * aggregation happens here, only response shaping to fit the ~8,000-char
 * BrandMind thread budget (`enforceThreadBudget` hard-truncates mid-JSON).
 * The projectors/shapers themselves live in `./search-performance-shape.js`.
 *
 * Canonical flow (see docs/98-search-console-mcp/00-plan.md Step 4):
 *   search_sources (is a connector even live?)
 *     → search_performance (SEO clicks/impressions/CTR/position + GA4 sessions/engagement)
 *     → search_ai_visibility / search_ai_citations (AI-answer-engine visibility)
 *     → search_worklist ("do this next", synthesized from all of the above)
 *     → feed gaps into seo_create_custom_brief / seo_generate_side_page.
 *
 * `spentUsd`/`costUsd` never appear in any of these payloads — the server's
 * `stripProviderSpendFields` already strips them from GEO DTOs before this
 * tool ever sees the response; use `creditsCharged` instead.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const DAYS = z.union([z.literal(7), z.literal(28), z.literal(90), z.literal(180), z.literal(480)]);
const DAYS_DESC = "Lookback window in days: 7, 28, 90, 180, or 480. Default 90.";

// ── Tool registration ─────────────────────────────────────────────────────

export function registerSearchPerformanceTools(server: McpServer) {
  // ── search_performance ────────────────────────────────────────────────
  server.tool(
    "search_performance",
    [
      "Search Console (Google/Bing) + GA4 performance readout for the brand — clicks, impressions, CTR, position, GA4 session/engagement/revenue numbers, an experimental search-to-GA funnel, and per-content-asset rollups. Proxies the Search Performance dashboard's core read model.",
      "Pick which slices to return with `sections` (default [\"summary\", \"analytics\"] — GA4 is the headline gap this tool used to miss entirely): \"summary\" = per-provider Search Console totals (never includes a google_analytics row — GA4 has no clicks/impressions/position concept, see below); \"queries\" = top search queries; \"pages\" = top landing pages; \"timeseries\" = clicks/impressions over time, bucketed by `granularity` and combined across providers into columnar {dates,clicks,impressions} arrays; \"analytics\" = the GA4 readout (sessions, engagement, revenue, AI-referral traffic, channel breakdown); \"funnel\" = the experimental Seen-to-Clicked-to-Visited-to-Engaged-to-Converted funnel (null unless both a search-console AND a GA connection are active); \"content\" = per-content-asset SEO+GA4 rollup (topContentDegraded is surfaced when the server failed to join content assets this call). The response echoes `availableSections`.",
      "`provider` filters \"summary\"/\"timeseries\" to one connected source. Passing `provider: \"google_analytics\"` returns an empty (correctly so) `summary` — GA4 rows never appear there — and automatically adds the \"analytics\" section so you still get real numbers back; a `note` explains this when it happens.",
      "`limit` (default 25, max 200) caps every list-shaped section: queries/pages/content rows, and (at detail=\"medium\"/\"full\") the analytics section's channels/aiReferrals.bySource/aiReferrals.topLandedPages arrays. `detail` controls verbosity: short = headline scalars only, no timeseries; medium = adds capped breakdowns + timeseries downsampled to weekly buckets; full = the raw API shape, timeseries capped to the most recent `limit` points instead of bucketed.",
      "Requires at least one connected search source (see `search_sources`) — an unconnected brand returns an empty summary, not an error.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      provider: z
        .enum(["google_search_console", "bing_webmaster", "google_analytics"])
        .optional()
        .describe(
          'Filter to one connected source. Omit to include every connected provider. "google_analytics" always forces the "analytics" section on (see tool description).'
        ),
      origin: z
        .enum(["POSTKING", "POSTKING_EXTERNAL", "IMPORTED", "EXTERNAL"])
        .optional()
        .describe("Filter by content-asset origin (advanced; usually omit)."),
      sections: z
        .array(z.enum(SEARCH_PERFORMANCE_SECTIONS))
        .optional()
        .default(["summary", "analytics"])
        .describe(
          'Which slices to include. Default ["summary", "analytics"] — add "queries"/"pages"/"timeseries"/"funnel"/"content" as needed. See availableSections in the response.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(25)
        .describe("Max rows per list-shaped section (default 25, max 200)."),
      granularity: z.enum(["day", "week", "month"]).optional().default("week").describe("Bucket size for the timeseries section (default week)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ days, provider, origin, sections, limit, granularity, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("days", String(days));
      if (provider) qs.set("provider", provider);
      if (origin) qs.set("origin", origin);
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/search-performance${suffix}`);
      const result = shapeSearchPerformance(data, { days, provider, sections, limit, granularity, detail });
      result.dashboardUrl = brandDashboardUrl(id, "search_performance");
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── search_ai_visibility ─────────────────────────────────────────────
  server.tool(
    "search_ai_visibility",
    [
      "Deep AI Dive (GEO) visibility readout — how often the brand is mentioned/cited by AI answer engines (Google AI Overview, ChatGPT, Perplexity, Claude) vs. competitors, across topics. Proxies the AI Visibility dashboard door. Requires PRO+ tier — a brand below that tier still gets an empty readout, not an error.",
      "Pick which slices to return with `sections` (default [\"summary\", \"coverage\", \"outreach\"]): \"summary\" = headline blendedCoverage + latestRun + verification + measurement; \"coverage\" = coverageByTopic; \"outreach\" = outreachTargets; \"leaderboard\" = citation leaderboard; \"competitors\" = competitorFootprints + brandMatrix; \"channels\" = channelMix + domainSplit + ownedEarnedTrend; \"runs\" = run history; \"confidence\" = topicConfidence. The response always includes `availableSections` listing all of these.",
      "Defaults to detail=\"short\" because the raw payload can run 30-80KB (blended coverage, per-topic breakdowns, citation leaderboard, competitor footprints, verification). detail=\"medium\" gives a fuller-but-still-capped view; \"full\" returns raw rows and is best used with a small `limit` on one section at a time.",
      "`limit` (default 12, max 200) caps every list section, INCLUDING citation-like lists (outreachTargets, leaderboard, domainSplit.domains, competitorFootprints[].pages, verification.unreachableUrls, blendedCoverage.sources) — there is no separate lower cap on those anymore, so raising `limit` shows more of everything; each capped list still reports its own `*Total` count alongside. The default is kept lower than this file's other tools because the default sections (summary+coverage+outreach) already combine several capped lists at once — raise `limit` explicitly for a fuller pull.",
      "Pass `market` to scope to one configured market key (see the dashboard's Markets axis) — an unrecognized or unset market degrades to an empty readout rather than a 400.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      market: z.string().optional().describe("Market key to scope the readout to. Omit for the worldwide/all-runs readout."),
      sections: z
        .array(z.enum(AI_VISIBILITY_SECTIONS))
        .optional()
        .default(["summary", "coverage", "outreach"])
        .describe(
          'Which slices to include. Default ["summary", "coverage", "outreach"] — add "leaderboard"/"competitors"/"channels"/"runs"/"confidence" as needed. The response echoes `availableSections`.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(12)
        .describe(
          "Max rows per list section, including citation-like lists (default 12, max 200). Kept lower than this file's other tools by design: with the default sections and detail=\"short\", a brand with a lot of AI-visibility history can otherwise blow past the ~8,000-char BrandMind thread budget — raise it explicitly when you need more."
        ),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ days, market, sections, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("days", String(days));
      if (market) qs.set("market", market);
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/search-performance/ai-visibility${suffix}`);
      const result = shapeAiVisibility(data, { days, market: market ?? null, limit, detail, sections });
      result.dashboardUrl = brandDashboardUrl(id, "search_performance");
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── search_ai_citations ──────────────────────────────────────────────
  server.tool(
    "search_ai_citations",
    [
      "Bing 'AI Performance' citation readout — daily citation counts, the latest grounding-query snapshot, and the latest cited-page snapshot from an imported Bing Copilot AI Performance CSV export. Distinct from search_ai_visibility (probed Deep AI Dive/GEO engines) — this is Bing-reported citation data.",
      "Returns an empty readout (not an error) when the brand has no Bing Webmaster connection or no AI Performance CSV has been imported yet.",
      "`limit` (default 25, max 200) caps the daily-points and snapshot-row arrays (daily keeps the most recent points). detail: short = {query|page, citations}; medium adds intent/topic/citationSharePct for queries; full = raw rows.",
    ].join(" "),
    {
      limit: z.number().int().min(1).max(200).optional().default(25).describe("Max rows per array (default 25, max 200)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/search-performance/ai-citations`);
      const raw = asObj(data);
      const dailyRows = asRows(raw.daily);
      const dailySliced = dailyRows.slice(-limit);
      const queryShot = raw.latestQuerySnapshot != null && typeof raw.latestQuerySnapshot === "object" ? asObj(raw.latestQuerySnapshot) : null;
      const pageShot = raw.latestPageSnapshot != null && typeof raw.latestPageSnapshot === "object" ? asObj(raw.latestPageSnapshot) : null;
      const queryRows = queryShot ? asRows(queryShot.rows) : [];
      const pageRows = pageShot ? asRows(pageShot.rows) : [];

      const result: Record<string, unknown> = {
        success: raw.success ?? true,
        detail,
        daily: dailySliced.map((d) => ({ date: d.date, citations: d.citations, citedPages: d.citedPages })),
        dailyTotal: dailyRows.length,
        latestQuerySnapshot: queryShot
          ? { exportDate: queryShot.exportDate, rows: projectList(detail, queryRows.slice(0, limit), aiCitationQueryProj), rowsTotal: queryRows.length }
          : null,
        latestPageSnapshot: pageShot
          ? {
              exportDate: pageShot.exportDate,
              rows: pageRows.slice(0, limit).map((p) => ({ page: p.page, citations: p.citations })),
              rowsTotal: pageRows.length,
            }
          : null,
      };

      const count = dailySliced.length + Math.min(queryRows.length, limit) + Math.min(pageRows.length, limit);
      const total = dailyRows.length + queryRows.length + pageRows.length;
      const truncated = count < total;
      result.count = count;
      result.total = total;
      result.truncated = truncated;
      result.dashboardUrl = brandDashboardUrl(id, "search_performance");
      if (truncated) {
        result.note = `Showing ${count} of ${total} rows. Raise \`limit\` (max 200) to see more.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── search_worklist ──────────────────────────────────────────────────
  server.tool(
    "search_worklist",
    [
      "\"Do this next\" search/AI-visibility worklist — a ranked list of concrete SEO + GEO actions synthesized from search_performance, search_ai_visibility, and search_ai_citations (e.g. pages losing clicks, gap queries with no landing page, outreach targets a competitor owns). Mirrors the dashboard's 'Do this next' section.",
      "Each item's `kind` is \"seo\" or \"geo\". short detail = {id, kind, title, impact, effort}; medium adds ctaLabel, deepLink, pageType, a truncated `why` sentence, and pagesCount; full = the raw item.",
      "`limit` (default 25, max 200) caps how many items are returned.",
      "Feed gaps this surfaces into `seo_create_custom_brief` or `seo_generate_side_page` to close them.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      limit: z.number().int().min(1).max(200).optional().default(25).describe("Max items to return (default 25, max 200)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ days, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      qs.set("days", String(days));
      const suffix = `?${qs.toString()}`;
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/search-performance/worklist${suffix}`);
      const rawObj = asObj(data);
      const rows = Array.isArray(data) ? asRows(data) : asRows(rawObj.items ?? rawObj.worklist);
      const sliced = rows.slice(0, limit);
      const truncated = sliced.length < rows.length;

      const result: Record<string, unknown> = {
        items: projectList(detail, sliced, worklistProj),
        count: sliced.length,
        total: rows.length,
        truncated,
        detail,
        dashboardUrl: brandDashboardUrl(id, "search_performance"),
      };
      if (truncated) {
        result.note = `Showing ${sliced.length} of ${rows.length} worklist items. Raise \`limit\` (max 200) to see the rest.`;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── search_sources ───────────────────────────────────────────────────
  server.tool(
    "search_sources",
    [
      "List the brand's connected search-performance sources (Google Search Console, Bing Webmaster, Google Analytics) — id, provider, site URL, and connection status. Check this first to see whether search_performance/search_ai_citations have anything to report.",
      "Small dataset — no pagination. detail defaults to \"full\" (the raw connection list); short = {id, provider, siteUrl, status}, medium adds authType/lastSyncedAt/lastError.",
    ].join(" "),
    {
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/search-sources`);
      const raw = asObj(data);
      const rows = asRows(raw.connections);
      const result = {
        success: raw.success ?? true,
        connections: projectList(detail, rows, sourceProj),
        count: rows.length,
        total: rows.length,
        truncated: false,
        detail,
        dashboardUrl: brandDashboardUrl(id, "search_performance"),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
