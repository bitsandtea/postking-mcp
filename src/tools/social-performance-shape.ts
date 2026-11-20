import { type Detail, truncate } from "../detail.js";

/**
 * Response shaping for the social performance tools (feature 157).
 * The server returns the full read model; this only trims it so a multi-brand
 * sweep (detail=short) stays small. null = "not provided / not measured"
 * and is always passed through untouched — never coerced to 0.
 */

export const SOCIAL_PERFORMANCE_SECTIONS = [
  "summary",
  "accounts",
  "topPosts",
  "timeseries",
  "cadence",
  "bottomPosts",
  "bestTimes",
  "byTheme",
  "byFormat",
] as const;
export const SOCIAL_PERFORMANCE_PLATFORMS = ["x", "facebook", "linkedin", "linkedin_company", "threads", "instagram"] as const;

type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

export function asRows(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter((r): r is Obj => !!r && typeof r === "object") : [];
}

function pickKeys(o: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function postRow(detail: Detail, p: Obj): Obj {
  if (detail === "full") return p;
  const base = pickKeys(p, ["postId", "platform", "publishedAt", "impressions", "reactions", "likes", "comments", "engagementRate"]);
  const preview = truncate(p.preview, detail === "short" ? 80 : 140);
  const out: Obj = { ...base, preview };
  if (detail === "medium") {
    Object.assign(out, pickKeys(p, ["accountId", "postLink", "shares", "quotes", "clicks", "measuredAt", "deletedOnPlatform", "duplicateOf", "note", "theme", "format", "visualType"]));
    if (p.hook !== undefined) out.hook = typeof p.hook === "string" ? truncate(p.hook, 100) : p.hook;
  } else {
    if (p.deletedOnPlatform === true) out.deletedOnPlatform = true;
    if (p.duplicateOf) out.duplicateOf = p.duplicateOf;
  }
  return out;
}

function accountRow(detail: Detail, a: Obj): Obj {
  if (detail === "full") return a;
  const short = pickKeys(a, ["accountId", "platform", "type", "handle", "status", "followers", "followersPrevious", "posts", "impressions", "engagementRate"]);
  // Surface a broken metrics sync even in the compact view; ok is the unremarkable default.
  if (a.metricsStatus === "sync_failing") Object.assign(short, pickKeys(a, ["metricsStatus", "metricsError", "metricsStaleSince"]));
  if (detail === "short") return short;
  return {
    ...short,
    ...pickKeys(a, ["name", "statusSince", "lastSyncAt", "historyStart", "postsPrevious", "impressionsPrevious", "engagements", "engagementsPrevious", "engagementRateBasis", "metricsAvailable", "metricsStatus", "metricsError", "metricsStaleSince", "notes"]),
  };
}

function cadenceShape(detail: Detail, c: Obj): Obj {
  if (detail === "full") return c;
  const head = pickKeys(c, ["targetPerWeek", "publishedThisWeek", "publishedLastWeek", "streakWeeks"]);
  if (detail === "medium") head.weeklyPosts = c.weeklyPosts;
  const per = asRows(c.perPlatform).map((p) =>
    detail === "short"
      ? pickKeys(p, ["platform", "target", "thisWeek", "lastWeek", "onTarget"])
      : p
  );
  head.perPlatform = per;
  return head;
}

const BEST_TIMES_CAP = { short: 3, medium: 10 } as const;
const GROUPS_CAP = { short: 5, medium: 10 } as const;

function groupShape(detail: Detail, g: Obj): Obj {
  const base = pickKeys(g, ["key", "posts", "impressions", "engagementRate", "medianEngagementRate", "lowSample"]);
  if (detail === "short") return base;
  return { ...base, ...pickKeys(g, ["engagements", "clicks", "engagementRateBasis"]) };
}

function groupsShape(detail: Detail, rows: unknown): Obj[] | unknown {
  if (detail === "full") return rows;
  const cap = GROUPS_CAP[detail === "short" ? "short" : "medium"];
  return asRows(rows).slice(0, cap).map((g) => groupShape(detail, g));
}

/** Cells arrive best-first (trustworthy rates, then thin ones); keep the head and say how many were cut. */
function bestTimesShape(detail: Detail, bt: Obj): Obj {
  if (detail === "full") return bt;
  const cap = BEST_TIMES_CAP[detail === "short" ? "short" : "medium"];
  return {
    ...pickKeys(bt, ["timezone"]),
    platforms: asRows(bt.platforms).map((pl) => {
      const cells = asRows(pl.cells);
      const kept = cells.slice(0, cap).map((c) => ({
        ...pickKeys(c, ["day", "hour", "posts", "engagementRate", "medianEngagementRate", "lowSample"]),
        ...(detail === "medium" ? pickKeys(c, ["impressions", "engagements", "engagementRateBasis"]) : {}),
      }));
      return {
        ...pickKeys(pl, ["platform", "posts"]),
        cellsTotal: cells.length,
        cells: kept,
        ...(cells.length > kept.length ? { truncated: true } : {}),
      };
    }),
  };
}

const TIMESERIES_CAP = 12;

function timeseriesShape(detail: Detail, t: Obj): Obj {
  if (detail === "full") return t;
  const dates = Array.isArray(t.dates) ? t.dates : [];
  if (dates.length <= TIMESERIES_CAP) return t;
  const start = dates.length - TIMESERIES_CAP;
  const out: Obj = { ...t, truncated: true, total: dates.length, note: `Showing the most recent ${TIMESERIES_CAP} of ${dates.length} buckets; use detail=full for all.` };
  for (const k of ["dates", "posts", "impressions", "engagements", "followers"]) {
    if (Array.isArray(t[k])) out[k] = (t[k] as unknown[]).slice(start);
  }
  return out;
}

/** Short = no timeseries, 3 top posts, compact accounts; medium adds detail; full = raw. */
export function shapeSocialPerformance(data: unknown, detail: Detail, sections?: readonly string[]): Obj {
  const raw = asObj(data);
  if (detail === "full") return { detail, ...raw };
  const want = (s: string) => !sections || sections.length === 0 || sections.includes(s);
  const out: Obj = { detail, ...pickKeys(raw, ["brandId", "days", "platform", "period", "previousCoverage"]) };
  if (raw.summary !== undefined && want("summary")) out.summary = raw.summary;
  if (raw.accounts !== undefined && want("accounts")) out.accounts = asRows(raw.accounts).map((a) => accountRow(detail, a));
  if (raw.topPosts !== undefined && want("topPosts")) {
    const top = asRows(raw.topPosts);
    out.topPosts = (detail === "short" ? top.slice(0, 3) : top).map((p) => postRow(detail, p));
  }
  if (raw.bottomPosts !== undefined && want("bottomPosts")) {
    const bottom = asRows(raw.bottomPosts);
    out.bottomPosts = (detail === "short" ? bottom.slice(0, 3) : bottom).map((p) => postRow(detail, p));
  }
  if (raw.bestTimes !== undefined && want("bestTimes")) out.bestTimes = bestTimesShape(detail, asObj(raw.bestTimes));
  if (raw.byTheme !== undefined && want("byTheme")) out.byTheme = groupsShape(detail, raw.byTheme);
  if (raw.byFormat !== undefined && want("byFormat")) out.byFormat = groupsShape(detail, raw.byFormat);
  if (raw.timeseries !== undefined && want("timeseries") && detail !== "short") out.timeseries = timeseriesShape(detail, asObj(raw.timeseries));
  if (raw.cadence !== undefined && want("cadence")) out.cadence = cadenceShape(detail, asObj(raw.cadence));
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  if (detail === "short") {
    const extra = ["bestTimes", "byTheme", "byFormat"].some((k) => raw[k] !== undefined && want(k))
      ? " bestTimes cells are UTC day x hour; lowSample=true means fewer than 3 posts with a measured rate, so treat that rate as anecdote (key null = dimension not stored)."
      : "";
    out.notes = [`null = the platform/account does not provide that metric (0 = measured zero). Read engagementRate next to raw counts. Use detail=medium for full notes.${extra}`];
  } else if (notes.length) {
    out.notes = notes;
  }
  if (detail === "short" && raw.timeseries !== undefined && want("timeseries")) out.timeseriesOmitted = "Use detail=medium or social_account_history for trends.";
  return out;
}

/** Keep only the most recent `limit` buckets in every columnar array. */
export function shapeAccountHistory(data: unknown, limit: number, detail: Detail): Obj {
  const raw = asObj(data);
  if (detail === "full") return raw;
  const dates = Array.isArray(raw.dates) ? raw.dates : [];
  if (dates.length <= limit) return { detail, ...raw };
  const start = dates.length - limit;
  const out: Obj = { detail, ...raw, truncated: true, total: dates.length };
  for (const k of ["dates", "followers", "impressions", "engagements", "posts"]) {
    if (Array.isArray(raw[k])) out[k] = (raw[k] as unknown[]).slice(start);
  }
  out.note = `Showing the most recent ${limit} of ${dates.length} buckets. Raise \`limit\` (max 200), narrow with from/to, or use a coarser granularity.`;
  return out;
}

/** Single post: headline + what it was made with; medium adds text, all marks and recent history. */
export function shapeSocialPostDetail(data: unknown, detail: Detail): Obj {
  const raw = asObj(data);
  if (detail === "full") return { detail, ...raw };
  const ctx = asObj(raw.context);
  const metrics = raw.metrics === null ? null : asObj(raw.metrics);
  const out: Obj = { detail, ...pickKeys(raw, ["brandId", "postId", "status", "platform", "publishedAt"]) };
  out.metrics =
    metrics === null || detail === "medium"
      ? metrics
      : pickKeys(metrics, ["impressions", "reactions", "comments", "engagementRate", "duplicateOf", "note"]);
  out.context =
    detail === "short"
      ? { ...pickKeys(ctx, ["theme", "format", "visualType", "visualSource", "voice"]), hook: truncate(ctx.hook, 100) }
      : ctx;
  if (detail === "medium") {
    out.postLink = raw.postLink;
    out.accountId = raw.accountId;
    out.content = truncate(raw.content, 600);
    out.engagementMarks = raw.engagementMarks;
    const history = Array.isArray(raw.history) ? raw.history : [];
    out.history = history.slice(-10);
    if (history.length > 10) out.historyNote = `Showing the latest 10 of ${history.length} syncs; use detail=full for all.`;
    if (Array.isArray(raw.notes) && raw.notes.length) out.notes = raw.notes;
  } else {
    out.marksCaptured = Array.isArray(raw.engagementMarks) ? raw.engagementMarks.length : 0;
  }
  return out;
}

export function shapeSocialPosts(data: unknown, detail: Detail): Obj {
  const raw = asObj(data);
  if (detail === "full") return { detail, ...raw };
  const out: Obj = { detail, ...pickKeys(raw, ["brandId", "days", "platform", "accountId", "sort"]) };
  out.posts = asRows(raw.posts).map((p) => postRow(detail, p));
  out.count = (out.posts as unknown[]).length;
  if (raw.pagination) out.pagination = raw.pagination;
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  if (detail === "short") {
    out.notes = ["null = not provided by the platform (0 = measured zero). Read engagementRate next to raw counts."];
  } else if (notes.length) out.notes = notes;
  return out;
}
