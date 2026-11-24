// Pure shaping helpers for the Reddit tools: what the agent sees for pool rows,
// suggestions, discovery rows and draft checks. No I/O here.

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Subs below this member count are flagged and left out of suggestions. */
export const MIN_MEMBERS = 500;

/** Accepts an object or a JSON string; anything else gives {}. */
export function parseJsonRec(v: unknown): Rec {
  if (isRec(v)) return v;
  if (typeof v === "string") {
    try {
      const p: unknown = JSON.parse(v);
      return isRec(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

function daysAgo(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** "active, last post 3 days ago (12 posts in 30 days)". Null when there is no activity data. */
export function activityLine(activity: unknown, now: number = Date.now()): string | null {
  if (!isRec(activity)) return null;
  const status = str(activity.status) ?? "unknown";
  if (status === "unknown") return "activity unknown";
  const last = str(activity.last_post_at);
  const d = last ? daysAgo(last, now) : null;
  const when = d === null ? "no recent post found" : d === 0 ? "last post today" : `last post ${d} day${d === 1 ? "" : "s"} ago`;
  const n = num(activity.posts_last_30d);
  return `${status}, ${when}${n !== null ? ` (${n} post${n === 1 ? "" : "s"} in 30 days)` : ""}`;
}

/** Plain-language warnings for a sub: under 500 members, or no post in 30 days. */
export function subWarnings(s: Rec): string[] {
  const out: string[] = [];
  const subs = num(s.subscribers);
  if (s.tiny === true || (subs !== null && subs < MIN_MEMBERS)) {
    out.push(`Under ${MIN_MEMBERS} members${subs !== null ? ` (${subs})` : ""} — too small to be worth a post; suggestions skip it.`);
  }
  if (isRec(s.activity) && s.activity.status === "inactive") {
    out.push("Inactive — no post in the last 30 days; suggestions skip it.");
  }
  return out;
}

const PROMO_LABELS: Record<string, string | null> = {
  links_allowed: null,
  mention_allowed: null,
  megathread_only: "Megathread only",
  no_promotion: "No promotion",
  unknown: "Rules not checked",
};

/** Server label when given, else derived from the policy. Null = promotion is allowed. */
export function promoLabel(s: Rec): string | null {
  if (s.promo_label !== undefined) return str(s.promo_label);
  const p = str(s.promo_policy);
  return p ? (PROMO_LABELS[p] ?? null) : null;
}

function restrictionList(v: unknown): Array<{ kind: unknown; rule: unknown; quote: unknown; note: unknown }> {
  if (!Array.isArray(v)) return [];
  return v.filter(isRec).map((r) => ({ kind: r.kind, rule: r.rule, quote: r.quote, note: r.note }));
}

/** One pool row. brand_fit (0-10) is the relevance number; row order is whatever the API returned. */
export function shapePoolRow(s: Rec, now: number = Date.now()): Rec {
  const fit = num(s.brand_fit) ?? num(s.gemini_score);
  const policy = isRec(s.rule_policy) ? s.rule_policy : null;
  const warnings = subWarnings(s);
  return {
    display_name: str(s.display_name),
    title: str(s.title),
    subscribers: num(s.subscribers),
    brand_fit: fit,
    activity: activityLine(s.activity, now),
    activity_status: isRec(s.activity) ? (str(s.activity.status) ?? "unknown") : null,
    tiny: s.tiny === true,
    promo_policy: str(s.promo_policy),
    promo_label: promoLabel(s),
    promo_policy_reason: str(s.promo_policy_reason),
    posting_style: str(s.posting_style),
    no_promotion_reason: str(s.no_promotion_reason),
    ...(policy ? { restrictions: restrictionList(policy.restrictions) } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Suggestion row at three detail levels. */
export function shapeSuggestion(r: Rec, detail: "short" | "medium" | "full", now: number = Date.now()): Rec {
  if (detail === "full") return r;
  const angles = Array.isArray(r.angles) ? r.angles.filter(isRec) : [];
  const first = angles[0];
  const base: Rec = {
    subreddit: r.subreddit,
    match_score: r.match_score,
    promo_policy: r.promo_policy,
    promo_label: promoLabel(r),
    activity: activityLine(r.activity, now),
    promotion_mode: r.promotion_mode,
    buyer_intent: r.buyer_intent,
  };
  const removals = num(r.past_removals);
  if (removals !== null && removals > 0) base.past_removals = removals;
  if (detail === "short") {
    return { ...base, angle: first ? { angle_type: first.angle_type, title: first.title } : null };
  }
  return {
    ...base,
    brand_fit: r.brand_fit,
    reason: r.reason,
    rule_to_watch: r.rule_to_watch,
    promo_policy_reason: r.promo_policy_reason,
    restrictions: restrictionList(r.restrictions),
    past_removals: removals ?? 0,
    angles: angles.map((a) => ({ angle_type: a.angle_type, title: a.title, hook: a.hook })),
  };
}

/** Notes shown above the suggestion list. */
export function suggestNotes(raw: Rec): string[] {
  const notes: string[] = [];
  const ex = isRec(raw.excluded) ? raw.excluded : null;
  const tiny = ex ? (num(ex.tiny) ?? 0) : 0;
  const inactive = ex ? (num(ex.inactive) ?? 0) : 0;
  if (tiny > 0 || inactive > 0) {
    notes.push(`Left out of the list: ${tiny} under ${MIN_MEMBERS} members, ${inactive} with no post in 30 days.`);
  }
  if (raw.removal_history === "never_synced") {
    notes.push("Removals are not tracked until the browser extension has synced your Reddit account, so past_removals is 0 for every sub.");
  }
  notes.push("Subs that allow promotion come first; restricted ones (no promotion, megathread only) are listed after, with a label.");
  return notes;
}

/** Discovery row. short/medium plus activity and size warnings. */
export function shapeDiscoveryRow(r: Rec, detail: "short" | "medium" | "full", now: number = Date.now()): Rec {
  if (detail === "full") return r;
  const warnings = subWarnings(r);
  const base: Rec = {
    display_name: r.display_name,
    subscribers: r.subscribers,
    already_in_pool: r.already_in_pool,
    activity: activityLine(r.activity, now),
    tiny: r.tiny === true,
    ...(warnings.length ? { warnings } : {}),
  };
  if (detail === "short") return base;
  const desc = str(r.public_description);
  return {
    ...base,
    title: r.title,
    public_description: desc && desc.length > 200 ? `${desc.slice(0, 200)}…` : desc,
    found_via: r.found_via,
    already_cached: r.already_cached,
  };
}

/** Result of reddit_add_to_pool: added rows with activity, size warnings and brand fit. */
export function shapeAddResult(data: unknown, now: number = Date.now()): Rec {
  const raw = isRec(data) ? data : {};
  const added = Array.isArray(raw.added) ? raw.added.filter(isRec) : [];
  return {
    ...raw,
    added: added.map((a) => {
      const warnings = subWarnings(a);
      return {
        display_name: a.display_name,
        title: a.title,
        subscribers: a.subscribers,
        brand_fit: num(a.brand_fit),
        posting_style: a.posting_style,
        activity: activityLine(a.activity, now),
        tiny: a.tiny === true,
        ...(warnings.length ? { warnings } : {}),
      };
    }),
  };
}

export type DraftState = "passed" | "needs_review" | "blocked" | "unchecked";

const CHECK_NOTE: Record<DraftState, string> = {
  passed: "Passed the checks. Safe to approve and post.",
  needs_review: "NOT approved. Quality issues survived automatic repair — edit the draft or regenerate before posting. Do not post it as it is.",
  blocked: "NOT approved. The text breaks a rule this subreddit states (or its promotion policy). Do not post it as it is — change the text or pick another subreddit.",
  unchecked: "No check on file (older draft). Review it before posting.",
};

/** Summary of one draft's stored check: state, reasons and a plain instruction. */
export function summarizeCheck(outputData: unknown): Rec {
  const od = parseJsonRec(outputData);
  const check = isRec(od.check) ? od.check : null;
  if (!check) return { state: "unchecked" satisfies DraftState, note: CHECK_NOTE.unchecked };
  const s = str(check.status);
  const state: DraftState = s === "passed" || s === "needs_review" || s === "blocked" ? s : "unchecked";
  const ruleBreaks = Array.isArray(check.ruleBreaks)
    ? check.ruleBreaks.filter(isRec).map((b) => ({ rule: b.rule, quote: b.quote ?? null, reason: b.reason }))
    : [];
  const issues = Array.isArray(check.issues) ? check.issues.filter((i): i is string => typeof i === "string") : [];
  const overridden = str(check.overriddenAt);
  return {
    state,
    ...(ruleBreaks.length ? { rule_breaks: ruleBreaks } : {}),
    ...(issues.length ? { issues } : {}),
    ...(overridden ? { overridden_at: overridden } : {}),
    note: overridden && state !== "passed" ? "Approved by the user despite the check." : CHECK_NOTE[state],
  };
}

/** A saved draft (list-posts row or get_post body): parsed outputData, post status, and a check summary. */
export function shapeDraft(post: Rec): Rec {
  const od = parseJsonRec(post.outputData);
  const check = summarizeCheck(od);
  const state = check.state as DraftState;
  const overridden = str(check.overridden_at) !== null;
  return {
    ...post,
    outputData: od,
    check,
    ready_to_post: state === "passed" || overridden,
  };
}

/** List-posts response: every draft shaped, plus a one-line legend. */
export function shapeDraftList(data: unknown): Rec {
  const raw = isRec(data) ? data : {};
  const posts = Array.isArray(raw.posts) ? raw.posts.filter(isRec).map(shapeDraft) : [];
  return {
    ...raw,
    posts,
    checkNote:
      "Each draft has a check: passed = approved and ready; needs_review and blocked = NOT approved, do not post them as they are. blocked lists the subreddit rule and the quoted words.",
  };
}

/** Rewrite job result: counts and per-draft checks. `drafts` are the saved draft posts (may be empty). */
export function shapeRewriteResult(job: Rec, drafts: Rec[], subredditNotice?: string): Rec {
  const jobOd = parseJsonRec(job.outputData);
  const counts = isRec(jobOd.counts) ? jobOd.counts : null;
  const shaped = drafts.map((d) => {
    const od = parseJsonRec(d.outputData);
    const c = summarizeCheck(od);
    return {
      postId: d.id ?? d.postId,
      subreddit: od.subreddit ?? d.platform ?? null,
      status: d.status ?? null,
      title: od.redditTitle ?? null,
      check: c,
      ready_to_post: c.state === "passed" || str(c.overridden_at) !== null,
    };
  });
  const notReady = counts ? (num(counts.needsReview) ?? 0) + (num(counts.blocked) ?? 0) : shaped.filter((d) => !d.ready_to_post).length;
  return {
    ...job,
    outputData: jobOd,
    ...(counts ? { counts } : {}),
    drafts: shaped,
    ...(notReady > 0
      ? { warning: `${notReady} draft${notReady === 1 ? "" : "s"} NOT approved (needs_review or blocked). Do not post those as they are — see each draft's check.` }
      : {}),
    ...(subredditNotice ? { subredditNotice } : {}),
  };
}
