import { type Detail, truncate } from "../detail.js";

/**
 * Response shaping for the social performance tools (feature 157).
 * The server returns the full read model; this only trims it so a multi-brand
 * sweep (detail=short) stays small. null = "not provided / not measured"
 * and is always passed through untouched — never coerced to 0.
 */

export const SOCIAL_PERFORMANCE_SECTIONS = ["summary", "accounts", "topPosts", "timeseries", "cadence"] as const;
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
    Object.assign(out, pickKeys(p, ["accountId", "postLink", "shares", "quotes", "clicks", "measuredAt", "deletedOnPlatform", "duplicateOf", "note"]));
  } else {
    if (p.deletedOnPlatform === true) out.deletedOnPlatform = true;
    if (p.duplicateOf) out.duplicateOf = p.duplicateOf;
  }
  return out;
}

function accountRow(detail: Detail, a: Obj): Obj {
  if (detail === "full") return a;
  const short = pickKeys(a, ["accountId", "platform", "type", "handle", "status", "followers", "followersPrevious", "posts", "impressions", "engagementRate"]);
  if (detail === "short") return short;
  return {
    ...short,
    ...pickKeys(a, ["name", "statusSince", "lastSyncAt", "historyStart", "postsPrevious", "impressionsPrevious", "engagements", "engagementsPrevious", "engagementRateBasis", "metricsAvailable", "notes"]),
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
  if (raw.timeseries !== undefined && want("timeseries") && detail !== "short") out.timeseries = timeseriesShape(detail, asObj(raw.timeseries));
  if (raw.cadence !== undefined && want("cadence")) out.cadence = cadenceShape(detail, asObj(raw.cadence));
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  if (detail === "short") {
    out.notes = ["null = the platform/account does not provide that metric (0 = measured zero). Read engagementRate next to raw counts. Use detail=medium for full notes."];
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
