import { describe, expect, it } from "vitest";
import { activityLine, shapeAddResult, shapeDraftList, shapePoolRow, shapeRewriteResult, shapeSuggestion, suggestNotes, summarizeCheck } from "../src/tools/reddit-shape.js";

const now = Date.parse("2026-11-24T12:00:00Z");

describe("pool row", () => {
  it("outputs brand_fit, activity line, tiny, promo label; no null score fields", () => {
    const row = shapePoolRow(
      { display_name: "r1", subscribers: 300, brand_fit: 8, tiny: true, promo_policy: "megathread_only", activity: { status: "inactive", last_post_at: "2026-10-01T12:00:00Z", posts_last_30d: 0, checked_at: null } },
      now
    ) as any;
    expect(row.brand_fit).toBe(8);
    expect(row.activity).toBe("inactive, last post 54 days ago (0 posts in 30 days)");
    expect(row.promo_label).toBe("Megathread only");
    expect(row.warnings).toHaveLength(2);
    expect("relevance_score" in row).toBe(false);
    expect("combined_score" in row).toBe(false);
  });
  it("handles missing activity", () => {
    expect(activityLine(undefined)).toBeNull();
  });
});

describe("suggestions", () => {
  const r = { subreddit: "x", match_score: 7, promo_policy: "no_promotion", promo_label: "No promotion", restrictions: [{ kind: "no_links", rule: "R1", quote: "no links", note: "n" }], past_removals: 2, angles: [{ angle_type: "tutorial", title: "t", hook: "h" }] };
  it("medium shows label, restrictions, removals", () => {
    const o = shapeSuggestion(r, "medium", now) as any;
    expect(o.promo_label).toBe("No promotion");
    expect(o.restrictions[0].quote).toBe("no links");
    expect(o.past_removals).toBe(2);
  });
  it("notes mention never_synced and exclusions", () => {
    const n = suggestNotes({ excluded: { tiny: 2, inactive: 1 }, removal_history: "never_synced" });
    expect(n.join(" ")).toContain("browser extension");
    expect(n.join(" ")).toContain("2 under 500");
  });
});

describe("add result", () => {
  it("warns on tiny", () => {
    const o = shapeAddResult({ added: [{ display_name: "a", subscribers: 100, tiny: true, brand_fit: 6 }], failed: [], poolSize: 1 }, now) as any;
    expect(o.added[0].warnings[0]).toContain("Under 500");
  });
});

describe("draft checks", () => {
  const blocked = { id: "d1", status: "created", outputData: JSON.stringify({ redditTitle: "T", check: { status: "blocked", ruleBreaks: [{ rule: "No ads", quote: "buy now", reason: "promo" }], issues: [] } }) };
  const passed = { id: "d2", status: "approved", outputData: { check: { status: "passed", ruleBreaks: [], issues: [] } } };
  it("list marks only passed drafts ready", () => {
    const o = shapeDraftList({ posts: [blocked, passed], nextCursor: null }) as any;
    expect(o.posts[0].ready_to_post).toBe(false);
    expect(o.posts[0].check.rule_breaks[0].quote).toBe("buy now");
    expect(o.posts[0].check.note).toContain("Do not post");
    expect(o.posts[1].ready_to_post).toBe(true);
  });
  it("rewrite result carries counts and a warning", () => {
    const job = { outputData: JSON.stringify({ counts: { passed: 1, needsReview: 0, blocked: 1 } }) };
    const o = shapeRewriteResult(job, [blocked, passed]) as any;
    expect(o.counts.blocked).toBe(1);
    expect(o.warning).toContain("NOT approved");
    expect(o.drafts).toHaveLength(2);
  });
});

describe("approve check summary", () => {
  it("summarizes a blocked check passed as details.check", () => {
    const o = summarizeCheck({ check: { status: "blocked", ruleBreaks: [{ rule: "No ads", quote: "buy", reason: "promo" }], issues: [] } }) as any;
    expect(o.state).toBe("blocked");
    expect(o.rule_breaks[0].quote).toBe("buy");
  });
});
