import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Detail, type Projector } from "../detail.js";
import { brandDashboardUrl } from "../links.js";

/**
 * Search Performance + AI Visibility — read-only reporting surface over the
 * Search Console / Bing Webmaster / GA4 connectors and the Deep AI Dive
 * (GEO visibility) engine. Every tool here proxies an existing dashboard
 * read model (PostKing's `src/services/search-performance/**`,
 * `src/services/geo-visibility/**`) via `/api/agent/v1/brands/{id}/...` — no
 * aggregation happens here, only response shaping to fit the ~8,000-char
 * BrandMind thread budget (`enforceThreadBudget` hard-truncates mid-JSON).
 *
 * Canonical flow (see docs/98-search-console-mcp/00-plan.md Step 4):
 *   search_sources (is a connector even live?)
 *     → search_performance (SEO clicks/impressions/CTR/position)
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

// ── Small numeric/shape helpers ──────────────────────────────────────────

function round1(n: unknown): number | null {
  return typeof n === "number" ? Math.round(n * 10) / 10 : null;
}

function round3(n: unknown): number | null {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => r != null && typeof r === "object") : [];
}

// ── search_performance: timeseries aggregation ───────────────────────────

type Granularity = "day" | "week" | "month";

function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const diff = (dow === 0 ? -6 : 1) - dow; // days back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function aggregateTimeseries(
  summaryRows: Record<string, unknown>[],
  granularity: Granularity
): { dates: string[]; clicks: number[]; impressions: number[] } {
  const buckets = new Map<string, { clicks: number; impressions: number }>();
  for (const row of summaryRows) {
    for (const point of asRows(row.timeseries)) {
      const date = typeof point.date === "string" ? point.date : null;
      if (!date) continue;
      const key = bucketKey(date, granularity);
      const bucket = buckets.get(key) ?? { clicks: 0, impressions: 0 };
      bucket.clicks += typeof point.clicks === "number" ? point.clicks : 0;
      bucket.impressions += typeof point.impressions === "number" ? point.impressions : 0;
      buckets.set(key, bucket);
    }
  }
  const dates = [...buckets.keys()].sort();
  return {
    dates,
    clicks: dates.map((d) => buckets.get(d)?.clicks ?? 0),
    impressions: dates.map((d) => buckets.get(d)?.impressions ?? 0),
  };
}

// ── search_performance projectors ────────────────────────────────────────

const summaryProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    provider: r.provider,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round1(r.ctr),
    avgPosition: round1(r.avgPosition),
  }),
  medium: (r) => {
    const prev = r.previous != null && typeof r.previous === "object" ? asObj(r.previous) : null;
    return {
      provider: r.provider,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: round1(r.ctr),
      avgPosition: round1(r.avgPosition),
      previous: prev
        ? { clicks: prev.clicks, impressions: prev.impressions, ctr: round1(prev.ctr), avgPosition: round1(prev.avgPosition) }
        : null,
    };
  },
};

const queryProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: round1(r.avgPosition) }),
  medium: (r) => ({
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round1(r.ctr),
    position: round1(r.avgPosition),
    google: r.google != null && typeof r.google === "object" ? r.google : null,
    bing: r.bing != null && typeof r.bing === "object" ? r.bing : null,
  }),
};

const pageProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: round1(r.avgPosition) }),
  medium: (r) => ({
    page: r.page,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round1(r.ctr),
    position: round1(r.avgPosition),
  }),
};

// ── search_ai_visibility projectors ──────────────────────────────────────

const runProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    runId: r.runId,
    provider: r.provider,
    generatedAt: r.generatedAt,
    focalMentionCoverage: round3(r.focalMentionCoverage),
  }),
  medium: (r) => ({
    runId: r.runId,
    provider: r.provider,
    model: r.model,
    generatedAt: r.generatedAt,
    marketKey: r.marketKey,
    topicCount: r.topicCount,
    questionCount: r.questionCount,
    responsesOk: r.responsesOk,
    citationCount: r.citationCount,
    creditsCharged: r.creditsCharged,
    focalMentionCoverage: round3(r.focalMentionCoverage),
    focalOwnedCitations: r.focalOwnedCitations,
    focalEarnedCitations: r.focalEarnedCitations,
  }),
};

const topicCoverageProj: Projector<Record<string, unknown>> = {
  short: (r) => {
    const focal = asObj(r.focal);
    return { topicId: r.topicId, label: truncate(r.label, 80), healthLight: r.healthLight, focalCoverage: round3(focal.coverage) };
  },
  medium: (r) => {
    const focal = asObj(r.focal);
    const top = r.topCompetitor != null && typeof r.topCompetitor === "object" ? asObj(r.topCompetitor) : null;
    return {
      topicId: r.topicId,
      label: truncate(r.label, 200),
      healthLight: r.healthLight,
      rankingVerdict: r.rankingVerdict,
      focal: { brand: focal.brand, coverage: round3(focal.coverage), mentionSov: round3(focal.mentionSov) },
      topCompetitor: top ? { brand: top.brand, coverage: round3(top.coverage) } : null,
    };
  },
};

const trendProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ runId: r.runId, generatedAt: r.generatedAt, provider: r.provider, owned: r.owned, earned: r.earned }),
  medium: (r) => ({
    runId: r.runId,
    generatedAt: r.generatedAt,
    provider: r.provider,
    owned: r.owned,
    earned: r.earned,
    mentionCoverage: round3(r.mentionCoverage),
  }),
};

const outreachProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ topicLabel: truncate(r.topicLabel, 80), url: r.url, domain: r.domain, citationCount: r.citationCount }),
  medium: (r) => ({
    topicLabel: truncate(r.topicLabel, 200),
    url: r.url,
    domain: r.domain,
    citationCount: r.citationCount,
    distinctQueries: r.distinctQueries,
    competitorsCited: r.competitorsCited,
  }),
};

const leaderboardProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ domain: r.domain, sourceType: r.sourceType, citationCount: r.citationCount }),
  medium: (r) => ({
    domain: r.domain,
    sourceType: r.sourceType,
    citationCount: r.citationCount,
    distinctQueries: r.distinctQueries,
    distinctUrls: r.distinctUrls,
    attributedBrands: r.attributedBrands,
  }),
};

const brandMatrixProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ topicId: r.topicId, brand: r.brand, isFocal: r.isFocal, coverage: round3(r.coverage) }),
  medium: (r) => ({
    topicId: r.topicId,
    topicLabel: truncate(r.topicLabel, 200),
    brand: r.brand,
    isFocal: r.isFocal,
    coverage: round3(r.coverage),
    mentionSov: round3(r.mentionSov),
    citationSov: round3(r.citationSov),
    prominence: round3(r.prominence),
  }),
};

const topicConfidenceProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ topicId: r.topicId, label: truncate(r.label, 80), healthLight: r.healthLight, rankingVerdict: r.rankingVerdict }),
  medium: (r) => ({
    topicId: r.topicId,
    label: truncate(r.label, 200),
    healthLight: r.healthLight,
    rankingVerdict: r.rankingVerdict,
    nQuestions: r.nQuestions,
    nResponsesOk: r.nResponsesOk,
    nResponsesError: r.nResponsesError,
    healthFlags: r.healthFlags,
  }),
};

function footprintProj(citeCap: number): Projector<Record<string, unknown>> {
  return {
    short: (r) => ({ competitor: r.competitor, totalEarnedCitations: r.totalEarnedCitations }),
    medium: (r) => {
      const pages = asRows(r.pages);
      return {
        competitor: r.competitor,
        totalEarnedCitations: r.totalEarnedCitations,
        pages: pages.slice(0, citeCap).map((p) => ({ url: p.url, domain: p.domain, citationCount: p.citationCount })),
        pagesTotal: pages.length,
      };
    },
  };
}

const channelMixScopeProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ topicId: r.topicId, topicLabel: truncate(r.topicLabel, 80), totalCitations: r.totalCitations, mix: r.mix }),
  medium: (r) => ({ topicId: r.topicId, topicLabel: truncate(r.topicLabel, 200), totalCitations: r.totalCitations, mix: r.mix }),
};

// ── search_ai_citations projector ────────────────────────────────────────

const aiCitationQueryProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ query: r.query, citations: r.citations }),
  medium: (r) => ({
    query: r.query,
    intent: r.intent,
    topic: r.topic,
    citations: r.citations,
    citationSharePct: round1(r.citationSharePct),
  }),
};

// ── search_worklist projector ────────────────────────────────────────────

const worklistProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, kind: r.kind, title: r.title, impact: r.impact, effort: r.effort }),
  medium: (r) => {
    const whyText = asRows(r.why)
      .map((seg) => (typeof seg.text === "string" ? seg.text : ""))
      .join(" ");
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      impact: r.impact,
      effort: r.effort,
      ctaLabel: r.ctaLabel,
      deepLink: r.deepLink ?? null,
      pageType: r.pageType ?? null,
      why: truncate(whyText, 200),
      pagesCount: Array.isArray(r.pages) ? r.pages.length : 0,
    };
  },
};

// ── search_sources projector ─────────────────────────────────────────────

const sourceProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, provider: r.provider, siteUrl: r.siteUrl, status: r.status }),
  medium: (r) => ({
    id: r.id,
    provider: r.provider,
    siteUrl: r.siteUrl,
    status: r.status,
    authType: r.authType,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
  }),
};

// ── search_ai_visibility: sections + shaping ─────────────────────────────

export const AI_VISIBILITY_SECTIONS = [
  "summary",
  "coverage",
  "outreach",
  "leaderboard",
  "competitors",
  "channels",
  "runs",
  "confidence",
] as const;

export type AiVisibilitySection = (typeof AI_VISIBILITY_SECTIONS)[number];

export interface ShapeAiVisibilityOpts {
  days: number;
  market: string | null;
  limit: number;
  detail: Detail;
  sections: AiVisibilitySection[];
}

/**
 * Shapes a raw `GeoVisibilityReadoutResponse` (types/geo-visibility.ts) into
 * the `search_ai_visibility` payload, gated by `opts.sections` so a default
 * call stays well under the ~8,000-char BrandMind thread budget. Pulled out
 * of the tool handler so it can be measured/tested without a live API call.
 */
export function shapeAiVisibility(data: unknown, opts: ShapeAiVisibilityOpts): Record<string, unknown> {
  const { days, market, limit, detail, sections } = opts;
  const raw = asObj(data);
  const citeCap = Math.min(limit, 15);
  const wantSections = new Set(sections);

  const result: Record<string, unknown> = {
    success: raw.success ?? true,
    detail,
    days,
    market: market ?? null,
    sections,
    availableSections: AI_VISIBILITY_SECTIONS,
  };

  let count = 0;
  let total = 0;
  let truncated = false;

  if (wantSections.has("summary")) {
    const latestRun = raw.latestRun != null && typeof raw.latestRun === "object" ? project(detail, asObj(raw.latestRun), runProj) : null;

    const blendedRaw = raw.blendedCoverage != null && typeof raw.blendedCoverage === "object" ? asObj(raw.blendedCoverage) : null;
    const blendedSources = blendedRaw ? asRows(blendedRaw.sources) : [];
    const blendedCoverage = blendedRaw
      ? {
          coverage: round3(blendedRaw.coverage),
          enginesIn: blendedRaw.enginesIn,
          enginesExpected: blendedRaw.enginesExpected,
          partial: blendedRaw.partial,
          sources: blendedSources.slice(0, limit).map((s) => ({
            provider: s.provider,
            label: s.label,
            marketKey: s.marketKey,
            coverage: round3(s.coverage),
            responsesOk: s.responsesOk,
          })),
          sourcesTotal: blendedSources.length,
        }
      : null;

    const verificationRaw = raw.verification != null && typeof raw.verification === "object" ? asObj(raw.verification) : null;
    const unreachableUrls = verificationRaw ? asRows(verificationRaw.unreachableUrls) : [];
    const verification = verificationRaw
      ? {
          reachable: verificationRaw.reachable,
          unreachable: verificationRaw.unreachable,
          unverified: verificationRaw.unverified,
          unreachableUrls: unreachableUrls.slice(0, citeCap).map((u) => ({ url: u.url, domain: u.domain, brand: u.brand })),
          unreachableUrlsTotal: unreachableUrls.length,
        }
      : null;

    result.latestRun = latestRun;
    result.blendedCoverage = blendedCoverage;
    result.verification = verification;
    result.measurement = raw.measurement ?? null;
  }

  if (wantSections.has("coverage")) {
    const topicRows = asRows(raw.coverageByTopic);
    const sliced = topicRows.slice(0, limit);
    result.coverageByTopic = projectList(detail, sliced, topicCoverageProj);
    result.coverageByTopicTotal = topicRows.length;
    count += sliced.length;
    total += topicRows.length;
    if (sliced.length < topicRows.length) truncated = true;
  }

  if (wantSections.has("outreach")) {
    const outreachRows = asRows(raw.outreachTargets);
    const sliced = outreachRows.slice(0, citeCap);
    result.outreachTargets = projectList(detail, sliced, outreachProj);
    result.outreachTargetsTotal = outreachRows.length;
    count += sliced.length;
    total += outreachRows.length;
    if (sliced.length < outreachRows.length) truncated = true;
  }

  if (wantSections.has("leaderboard")) {
    const leaderboardRows = asRows(raw.leaderboard);
    const sliced = leaderboardRows.slice(0, citeCap);
    result.leaderboard = projectList(detail, sliced, leaderboardProj);
    result.leaderboardTotal = leaderboardRows.length;
    count += sliced.length;
    total += leaderboardRows.length;
    if (sliced.length < leaderboardRows.length) truncated = true;
  }

  if (wantSections.has("competitors")) {
    const footprintRows = asRows(raw.competitorFootprints);
    const footprintSliced = footprintRows.slice(0, limit);
    result.competitorFootprints = projectList(detail, footprintSliced, footprintProj(citeCap));
    result.competitorFootprintsTotal = footprintRows.length;
    count += footprintSliced.length;
    total += footprintRows.length;
    if (footprintSliced.length < footprintRows.length) truncated = true;

    const brandMatrixRows = asRows(raw.brandMatrix);
    const brandMatrixSliced = brandMatrixRows.slice(0, limit);
    result.brandMatrix = projectList(detail, brandMatrixSliced, brandMatrixProj);
    result.brandMatrixTotal = brandMatrixRows.length;
    count += brandMatrixSliced.length;
    total += brandMatrixRows.length;
    if (brandMatrixSliced.length < brandMatrixRows.length) truncated = true;
  }

  if (wantSections.has("channels")) {
    const channelMixRaw = raw.channelMix != null && typeof raw.channelMix === "object" ? asObj(raw.channelMix) : null;
    const perTopicRows = channelMixRaw ? asRows(channelMixRaw.perTopic) : [];
    const perTopicSliced = perTopicRows.slice(0, limit);
    result.channelMix = channelMixRaw
      ? {
          overall: channelMixRaw.overall != null && typeof channelMixRaw.overall === "object" ? project(detail, asObj(channelMixRaw.overall), channelMixScopeProj) : null,
          perTopic: projectList(detail, perTopicSliced, channelMixScopeProj),
          perTopicTotal: perTopicRows.length,
        }
      : null;

    const domainSplitRaw = raw.domainSplit != null && typeof raw.domainSplit === "object" ? asObj(raw.domainSplit) : null;
    const domainSplitDomains = domainSplitRaw ? asRows(domainSplitRaw.domains) : [];
    result.domainSplit = domainSplitRaw
      ? {
          focalBrand: domainSplitRaw.focalBrand,
          totalCitations: domainSplitRaw.totalCitations,
          ownedCitations: domainSplitRaw.ownedCitations,
          earnedCitations: domainSplitRaw.earnedCitations,
          ownedToEarnedRatio: round3(domainSplitRaw.ownedToEarnedRatio),
          domains: domainSplitDomains
            .slice(0, citeCap)
            .map((d) => ({ domain: d.domain, ownedOrEarned: d.ownedOrEarned, citationCount: d.citationCount, share: round3(d.share) })),
          domainsTotal: domainSplitDomains.length,
        }
      : null;

    const trendRows = asRows(raw.ownedEarnedTrend);
    const trendSliced = trendRows.slice(0, limit);
    result.ownedEarnedTrend = projectList(detail, trendSliced, trendProj);
    result.ownedEarnedTrendTotal = trendRows.length;
    count += trendSliced.length;
    total += trendRows.length;
    if (trendSliced.length < trendRows.length) truncated = true;
  }

  if (wantSections.has("runs")) {
    const runRows = asRows(raw.runs);
    const sliced = runRows.slice(0, limit);
    result.runs = projectList(detail, sliced, runProj);
    result.runsTotal = runRows.length;
    count += sliced.length;
    total += runRows.length;
    if (sliced.length < runRows.length) truncated = true;
  }

  if (wantSections.has("confidence")) {
    const topicConfidenceRows = asRows(raw.topicConfidence);
    const sliced = topicConfidenceRows.slice(0, limit);
    result.topicConfidence = projectList(detail, sliced, topicConfidenceProj);
    result.topicConfidenceTotal = topicConfidenceRows.length;
    count += sliced.length;
    total += topicConfidenceRows.length;
    if (sliced.length < topicConfidenceRows.length) truncated = true;
  }

  result.count = count;
  result.total = total;
  result.truncated = truncated;
  if (truncated) {
    result.note = `Showing ${count} of ${total} rows across the requested sections (limit=${limit}, citation lists capped at ${citeCap}). Raise \`limit\` (max 50), call detail="full" on a narrower slice, or request another section (see availableSections) for more.`;
  }
  return result;
}

// ── Tool registration ─────────────────────────────────────────────────────

export function registerSearchPerformanceTools(server: McpServer) {
  // ── search_performance ────────────────────────────────────────────────
  server.tool(
    "search_performance",
    [
      "Search Console (Google/Bing) + GA4 performance readout for the brand — clicks, impressions, CTR, position, and (with GA4 connected) session/engagement numbers. Proxies the Search Performance dashboard's core read model.",
      "Pick which slices to return with `sections` (default [\"summary\"]): \"summary\" = per-provider totals; \"queries\" = top search queries; \"pages\" = top landing pages; \"timeseries\" = clicks/impressions over time, bucketed by `granularity` and combined across providers into columnar {dates,clicks,impressions} arrays.",
      "`limit` (default 10, max 50) caps the queries/pages arrays. `detail` controls per-row verbosity: short = {query|page, clicks, impressions, position}; medium adds ctr (+ per-provider split for queries); full = the raw API row.",
      "Requires at least one connected search source (see `search_sources`) — an unconnected brand returns an empty summary, not an error.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      provider: z
        .enum(["google_search_console", "bing_webmaster", "google_analytics"])
        .optional()
        .describe("Filter to one connected source. Omit to include every connected provider."),
      origin: z
        .enum(["POSTKING", "POSTKING_EXTERNAL", "IMPORTED", "EXTERNAL"])
        .optional()
        .describe("Filter by content-asset origin (advanced; usually omit)."),
      sections: z
        .array(z.enum(["summary", "queries", "pages", "timeseries"]))
        .optional()
        .default(["summary"])
        .describe('Which slices to include. Default ["summary"] — add "queries"/"pages"/"timeseries" as needed.'),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max rows for the queries/pages sections (default 10, max 50)."),
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
      const raw = asObj(data);
      const summaryRows = asRows(raw.summary);
      const queryRows = asRows(raw.topQueries);
      const pageRows = asRows(raw.topPages);
      const wantSections = new Set(sections);

      const result: Record<string, unknown> = { success: raw.success ?? true, days: raw.days ?? days, sections };
      let count = 0;
      let total = 0;
      let truncated = false;

      if (wantSections.has("summary")) {
        result.summary = projectList(detail, summaryRows, summaryProj);
        count += summaryRows.length;
        total += summaryRows.length;
      }
      if (wantSections.has("queries")) {
        const sliced = queryRows.slice(0, limit);
        result.topQueries = projectList(detail, sliced, queryProj);
        count += sliced.length;
        total += queryRows.length;
        if (sliced.length < queryRows.length) truncated = true;
      }
      if (wantSections.has("pages")) {
        const sliced = pageRows.slice(0, limit);
        result.topPages = projectList(detail, sliced, pageProj);
        count += sliced.length;
        total += pageRows.length;
        if (sliced.length < pageRows.length) truncated = true;
      }
      if (wantSections.has("timeseries")) {
        result.timeseries = aggregateTimeseries(summaryRows, granularity);
        result.granularity = granularity;
      }

      result.count = count;
      result.total = total;
      result.truncated = truncated;
      result.detail = detail;
      result.dashboardUrl = brandDashboardUrl(id, "search_performance");
      if (truncated) {
        result.note = `Showing ${count} of ${total} rows across the requested sections. Raise \`limit\` (max 50) to see more.`;
      }
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
      "`limit` (default 10, max 50) caps every list section; citation-like lists (outreachTargets, leaderboard, domainSplit.domains, competitorFootprints[].pages, verification.unreachableUrls, blendedCoverage.sources) are additionally hard-capped at 15, each with a `*Total` count alongside.",
      "Pass `market` to scope to one configured market key (see the dashboard's Markets axis) — an unrecognized or unset market degrades to an empty readout rather than a 400.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      market: z.string().optional().describe("Market key to scope the readout to. Omit for the worldwide/all-runs readout."),
      sections: z
        .array(z.enum(["summary", "coverage", "outreach", "leaderboard", "competitors", "channels", "runs", "confidence"]))
        .optional()
        .default(["summary", "coverage", "outreach"])
        .describe(
          'Which slices to include. Default ["summary", "coverage", "outreach"] — add "leaderboard"/"competitors"/"channels"/"runs"/"confidence" as needed. The response echoes `availableSections`.'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max rows per list section (default 10, max 50); citation-like lists are further capped at 15."),
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
      "`limit` (default 10, max 50) caps the daily-points and snapshot-row arrays (daily keeps the most recent points). detail: short = {query|page, citations}; medium adds intent/topic/citationSharePct for queries; full = raw rows.",
    ].join(" "),
    {
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max rows per array (default 10, max 50)."),
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
        result.note = `Showing ${count} of ${total} rows. Raise \`limit\` (max 50) to see more.`;
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
      "Feed gaps this surfaces into `seo_create_custom_brief` or `seo_generate_side_page` to close them.",
    ].join(" "),
    {
      days: DAYS.optional().default(90).describe(DAYS_DESC),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max items to return (default 10, max 50)."),
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
        result.note = `Showing ${sliced.length} of ${rows.length} worklist items. Raise \`limit\` (max 50) to see the rest.`;
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
