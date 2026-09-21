import { project, projectList, truncate, type Detail, type Projector } from "../detail.js";

/**
 * Response-shaping helpers for `search-performance.ts` — pulled into a
 * sibling module so the tool-registration file stays under the repo's
 * readability budget. Every projector/shaper here is a pure function over
 * the raw agent-v1 JSON (no network calls), so it can be unit-tested or
 * reasoned about independently of the MCP SDK plumbing.
 *
 * Shapes proxied (see PostKing's `types/search-performance.ts`):
 *   - `SearchPerformanceReadResponse` → `shapeSearchPerformance`
 *   - `GeoVisibilityReadoutResponse` (types/geo-visibility.ts) → `shapeAiVisibility`
 */

// ── Small numeric/shape helpers ──────────────────────────────────────────

export function round1(n: unknown): number | null {
  return typeof n === "number" ? Math.round(n * 10) / 10 : null;
}

export function round3(n: unknown): number | null {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : null;
}

export function asObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => r != null && typeof r === "object") : [];
}

// ── search_performance: timeseries aggregation ───────────────────────────

export type Granularity = "day" | "week" | "month";

export function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const diff = (dow === 0 ? -6 : 1) - dow; // days back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function aggregateTimeseries(
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

/** Sums `{date, value}` points (e.g. `AnalyticsDayValueDTO[]`) into weekly
 * (or monthly) buckets — the "downsampled rather than raw-daily" tier for
 * the analytics section's medium detail. */
export function bucketDayValues(points: Record<string, unknown>[], granularity: Granularity): { date: string; value: number }[] {
  const buckets = new Map<string, number>();
  for (const point of points) {
    const date = typeof point.date === "string" ? point.date : null;
    if (!date) continue;
    const key = bucketKey(date, granularity);
    const v = typeof point.value === "number" ? point.value : 0;
    buckets.set(key, (buckets.get(key) ?? 0) + v);
  }
  return [...buckets.keys()].sort().map((date) => ({ date, value: buckets.get(date) ?? 0 }));
}

// ── search_performance projectors ────────────────────────────────────────

export const summaryProj: Projector<Record<string, unknown>> = {
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

export const queryProj: Projector<Record<string, unknown>> = {
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

export const pageProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: round1(r.avgPosition) }),
  medium: (r) => ({
    page: r.page,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round1(r.ctr),
    position: round1(r.avgPosition),
  }),
};

/** `ContentAssetPerformanceRow` (PostKing's `types/content-assets.ts`) — the
 * per-content-asset SEO+GA4 rollup for the `"content"` section. */
export const contentProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ url: r.canonicalUrl, title: truncate(r.title, 80), clicks: r.clicks, sessions: r.sessions }),
  medium: (r) => ({
    assetId: r.assetId,
    url: r.canonicalUrl,
    title: truncate(r.title, 160),
    origin: r.origin,
    kind: r.kind,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: round1(r.ctr),
    position: round1(r.avgPosition),
    sessions: r.sessions,
    engagementRate: round3(r.engagementRate),
    keyEvents: r.keyEvents,
    aiCitations: r.aiCitations,
  }),
};

// ── search_performance: analytics (GA4) + funnel projection ─────────────

/**
 * Projects `AnalyticsSummaryDTO` (PostKing's `types/search-performance.ts`)
 * — the GA4 headline tile row. short = scalars only; medium = scalars +
 * weekly-bucketed trend lines; full = scalars + raw daily trend lines
 * (capped to the most recent `limit` points each).
 */
export function projectAnalyticsSummary(detail: Detail, summary: Record<string, unknown>, limit: number): Record<string, unknown> {
  const prev = summary.previous != null && typeof summary.previous === "object" ? asObj(summary.previous) : null;
  const headline: Record<string, unknown> = {
    sessions: summary.sessions,
    engagedSessions: summary.engagedSessions,
    engagementRate: round3(summary.engagementRate),
    avgEngagementSec: round1(summary.avgEngagementSec),
    keyEvents: summary.keyEvents,
    totalRevenue: summary.totalRevenue,
    aiReferralSessions: summary.aiReferralSessions,
    previous: prev
      ? {
          sessions: prev.sessions,
          engagedSessions: prev.engagedSessions,
          engagementRate: round3(prev.engagementRate),
          avgEngagementSec: round1(prev.avgEngagementSec),
          keyEvents: prev.keyEvents,
          totalRevenue: prev.totalRevenue,
        }
      : null,
  };
  if (detail === "short") return headline;

  const full = detail === "full";
  const series = (field: string) =>
    full ? asRows(summary[field] as unknown[]).slice(-limit) : bucketDayValues(asRows(summary[field] as unknown[]), "week");

  return {
    ...headline,
    timeseries: {
      granularity: full ? "day" : "week",
      sessions: series("sessionsTimeseries"),
      engagedSessions: series("engagedSessionsTimeseries"),
      keyEvents: series("keyEventsTimeseries"),
      revenue: series("revenueTimeseries"),
      aiReferral: series("aiReferralTimeseries"),
    },
  };
}

/** Projects `AiReferralBreakdownDTO` — dropped entirely at short detail
 * (the headline `aiReferralSessions` scalar already covers it); medium
 * keeps {source, sessions} / {canonicalUrl, title, sessions}; full keeps
 * every field, both lists capped to `limit`. */
export function projectAiReferrals(detail: Detail, aiReferrals: Record<string, unknown>, limit: number): Record<string, unknown> {
  const bySourceRows = asRows(aiReferrals.bySource);
  const topLandedRows = asRows(aiReferrals.topLandedPages);
  const bySourceSliced = bySourceRows.slice(0, limit);
  const topLandedSliced = topLandedRows.slice(0, limit);
  const full = detail === "full";
  return {
    bySource: bySourceSliced.map((r) => (full ? r : { source: r.source, sessions: r.sessions })),
    bySourceTotal: bySourceRows.length,
    topLandedPages: topLandedSliced.map((r) =>
      full ? r : { canonicalUrl: r.canonicalUrl, title: truncate(r.title, 120), sessions: r.sessions }
    ),
    topLandedPagesTotal: topLandedRows.length,
  };
}

/** Projects `ChannelBreakdownRowDTO[]` — medium keeps {channel, sessions,
 * engagementRate, share}; full keeps every field (including each row's own
 * `timeseries`/`topSources`, `topSources` further capped to `limit`). */
export function projectChannels(detail: Detail, channels: Record<string, unknown>[], limit: number): unknown[] {
  const sliced = channels.slice(0, limit);
  const full = detail === "full";
  return sliced.map((r) =>
    full
      ? { ...r, topSources: asRows(r.topSources).slice(0, limit) }
      : { channel: r.channel, sessions: r.sessions, engagementRate: round3(r.engagementRate), share: round3(r.share) }
  );
}

/**
 * Projects `AnalyticsReadModelResponse | null` (the `"analytics"` section)
 * — `null` straight through (brand has no GA4 connection). short detail
 * returns just the summary headline; medium/full add channels + aiReferrals.
 */
export function projectAnalytics(detail: Detail, raw: unknown, limit: number): Record<string, unknown> | null {
  if (raw == null) return null;
  const a = asObj(raw);
  const summary = asObj(a.summary);
  const result: Record<string, unknown> = { summary: projectAnalyticsSummary(detail, summary, limit) };
  if (detail !== "short") {
    result.aiReferrals = projectAiReferrals(detail, asObj(a.aiReferrals), limit);
    const channelRows = asRows(a.channels);
    result.channels = projectChannels(detail, channelRows, limit);
    result.channelsTotal = channelRows.length;
  }
  return result;
}

/** Projects `FunnelDTO | null` (the `"funnel"` section) — tiny (4-5 stages),
 * so it is emitted whole regardless of `detail`. */
export function projectFunnel(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  const f = asObj(raw);
  return {
    days: f.days,
    stages: asRows(f.stages).map((s) => ({
      key: s.key,
      label: s.label,
      count: s.count,
      rateFromPrevious: round3(s.rateFromPrevious),
    })),
  };
}

// ── search_performance: sections + top-level shaper ──────────────────────

export const SEARCH_PERFORMANCE_SECTIONS = ["summary", "queries", "pages", "timeseries", "analytics", "funnel", "content"] as const;
export type SearchPerformanceSection = (typeof SEARCH_PERFORMANCE_SECTIONS)[number];

export interface ShapeSearchPerformanceOpts {
  days: number;
  provider?: string;
  sections: SearchPerformanceSection[];
  limit: number;
  granularity: Granularity;
  detail: Detail;
}

/**
 * Shapes a raw `SearchPerformanceReadResponse` (types/search-performance.ts)
 * into the `search_performance` payload. Two corrections over the raw API
 * shape: (1) the phantom `{provider: "google_analytics", clicks: 0, ...}`
 * row is filtered out of `summary` — GA4 has no Search Console
 * clicks/impressions/position concept, so that row always reads zero and
 * misleads a client into thinking the connector is broken; its real numbers
 * live in the `"analytics"` section. (2) requesting `provider:
 * "google_analytics"` forces the `"analytics"` section into the response
 * (even if not in `sections`) so the filter still returns something useful
 * instead of an empty `summary`.
 */
export function shapeSearchPerformance(data: unknown, opts: ShapeSearchPerformanceOpts): Record<string, unknown> {
  const { days, provider, sections, limit, granularity, detail } = opts;
  const raw = asObj(data);
  const wantSections = new Set<SearchPerformanceSection>(sections);
  if (provider === "google_analytics") wantSections.add("analytics");

  const summaryRows = asRows(raw.summary).filter((r) => r.provider !== "google_analytics");
  const queryRows = asRows(raw.topQueries);
  const pageRows = asRows(raw.topPages);
  const contentRows = asRows(raw.topContent);

  const result: Record<string, unknown> = {
    success: raw.success ?? true,
    days: raw.days ?? days,
    sections: [...wantSections],
    availableSections: SEARCH_PERFORMANCE_SECTIONS,
  };

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
  if (wantSections.has("content")) {
    const sliced = contentRows.slice(0, limit);
    result.topContent = projectList(detail, sliced, contentProj);
    result.topContentTotal = contentRows.length;
    if (raw.topContentDegraded) result.topContentDegraded = true;
    count += sliced.length;
    total += contentRows.length;
    if (sliced.length < contentRows.length) truncated = true;
  }
  if (wantSections.has("analytics")) {
    const analyticsRaw = raw.analytics;
    result.analytics = projectAnalytics(detail, analyticsRaw, limit);
    if (analyticsRaw != null && detail !== "short") {
      const a = asObj(analyticsRaw);
      const channelRows = asRows(a.channels);
      const aiRef = asObj(a.aiReferrals);
      if (channelRows.length > limit || asRows(aiRef.bySource).length > limit || asRows(aiRef.topLandedPages).length > limit) {
        truncated = true;
      }
    }
  }
  if (wantSections.has("funnel")) {
    result.funnel = projectFunnel(raw.funnel);
  }

  result.count = count;
  result.total = total;
  result.truncated = truncated;
  result.detail = detail;

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Showing ${count} of ${total} rows across the requested list sections (limit=${limit}, max 200). Raise \`limit\`, call detail="full" for uncapped analytics/channel breakdowns, or request another section (see availableSections) for more.`
    );
  }
  if (provider === "google_analytics") {
    notes.push(
      'google_analytics has no clicks/impressions/position rows in Search Console data — its real numbers are in the "analytics" section, auto-included here because provider=google_analytics was requested.'
    );
  }
  if (notes.length > 0) result.note = notes.join(" ");

  return result;
}

// ── search_ai_visibility projectors ──────────────────────────────────────

export const runProj: Projector<Record<string, unknown>> = {
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

export const topicCoverageProj: Projector<Record<string, unknown>> = {
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

export const trendProj: Projector<Record<string, unknown>> = {
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

export const outreachProj: Projector<Record<string, unknown>> = {
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

export const leaderboardProj: Projector<Record<string, unknown>> = {
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

export const brandMatrixProj: Projector<Record<string, unknown>> = {
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

export const topicConfidenceProj: Projector<Record<string, unknown>> = {
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

export function footprintProj(citeCap: number): Projector<Record<string, unknown>> {
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

export const channelMixScopeProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ topicId: r.topicId, topicLabel: truncate(r.topicLabel, 80), totalCitations: r.totalCitations, mix: r.mix }),
  medium: (r) => ({ topicId: r.topicId, topicLabel: truncate(r.topicLabel, 200), totalCitations: r.totalCitations, mix: r.mix }),
};

// ── search_ai_citations projector ────────────────────────────────────────

export const aiCitationQueryProj: Projector<Record<string, unknown>> = {
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

export const worklistProj: Projector<Record<string, unknown>> = {
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

export const sourceProj: Projector<Record<string, unknown>> = {
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
 * Every citation-like list (outreachTargets, leaderboard, domainSplit.domains,
 * competitorFootprints[].pages, verification.unreachableUrls,
 * blendedCoverage.sources) is capped at the caller's own `limit` — there is
 * no separate, lower hard cap.
 */
export function shapeAiVisibility(data: unknown, opts: ShapeAiVisibilityOpts): Record<string, unknown> {
  const { days, market, limit, detail, sections } = opts;
  const raw = asObj(data);
  const citeCap = limit;
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
          sources: blendedSources.slice(0, citeCap).map((s) => ({
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
    result.note = `Showing ${count} of ${total} rows across the requested sections (limit=${limit}, citation-like lists also capped at ${citeCap}). Raise \`limit\` (max 200), call detail="full" on a narrower slice, or request another section (see availableSections) for more.`;
  }
  return result;
}
