import { describe, expect, it } from "vitest";
import { shapeSocialPerformance, shapeSocialPostDetail, shapeSocialPosts } from "../src/tools/social-performance-shape.js";

const cell = (day: string, hour: number, er: number | null) => ({ day, hour, dayOfWeek: 0, posts: 2, impressions: 100, engagements: 5, clicks: null, engagementRate: er, engagementRateBasis: null, medianEngagementRate: er, lowSample: true, key: null });
const group = (key: string | null, posts: number) => ({ key, posts, impressions: 100, engagements: 5, clicks: null, engagementRate: 0.05, engagementRateBasis: { posts, impressions: 100, engagements: 5 }, medianEngagementRate: 0.04, lowSample: posts < 3 });

describe("shapeSocialPerformance (card #29 sections)", () => {
  const raw = {
    brandId: "b",
    days: 28,
    bestTimes: { timezone: "UTC", platforms: [{ platform: "x", posts: 9, cells: Array.from({ length: 8 }, (_, i) => cell("Mon", i, 0.1 - i / 100)) }] },
    byTheme: Array.from({ length: 7 }, (_, i) => group(`t${i}`, 3)),
    byFormat: [group("text", 4), group(null, 1)],
    bottomPosts: Array.from({ length: 5 }, (_, i) => ({ postId: `p${i}`, platform: "x", preview: "x", impressions: null })),
    notes: ["n"],
  };

  it("short keeps 3 cells per platform and 5 groups, passing nulls through", () => {
    const out = shapeSocialPerformance(raw, "short") as any;
    expect(out.bestTimes.platforms[0].cells).toHaveLength(3);
    expect(out.bestTimes.platforms[0].cellsTotal).toBe(8);
    expect(out.bestTimes.platforms[0].truncated).toBe(true);
    expect(out.byTheme).toHaveLength(5);
    expect(out.byFormat[1].key).toBeNull();
    expect(out.bottomPosts).toHaveLength(3);
    expect(out.notes[0]).toContain("lowSample");
  });

  it("medium keeps up to 10 and adds counts; full is raw", () => {
    const med = shapeSocialPerformance(raw, "medium") as any;
    expect(med.bestTimes.platforms[0].cells).toHaveLength(8);
    expect(med.byTheme).toHaveLength(7);
    expect(med.byTheme[0].engagementRateBasis).toBeDefined();
    expect((shapeSocialPerformance(raw, "full") as any).byTheme).toHaveLength(7);
  });
});

describe("shapeSocialPosts context fields", () => {
  const row = { postId: "p", platform: "linkedin", preview: "hi", impressions: 10, theme: "Pricing", format: "image", visualType: "image", hook: "A hook", theme_unused: 1 };
  it("short omits context, medium includes it", () => {
    expect((shapeSocialPosts({ posts: [row] }, "short") as any).posts[0].theme).toBeUndefined();
    const m = (shapeSocialPosts({ posts: [row] }, "medium") as any).posts[0];
    expect(m).toMatchObject({ theme: "Pricing", format: "image", visualType: "image", hook: "A hook" });
  });
});

describe("shapeSocialPostDetail", () => {
  const raw = {
    postId: "p",
    status: "posted",
    platform: "x",
    publishedAt: "2026-11-01T00:00:00Z",
    content: "x".repeat(900),
    metrics: { impressions: null, reactions: 3, comments: 0, engagementRate: null },
    context: { theme: "T", hook: "H", format: "text", visualType: "none", visualSource: null, voice: null },
    engagementMarks: [{ mark: "T12" }],
    history: Array.from({ length: 12 }, (_, i) => ({ at: String(i) })),
  };
  it("short is compact; medium has marks and last 10 history rows", () => {
    const s = shapeSocialPostDetail(raw, "short") as any;
    expect(s.content).toBeUndefined();
    expect(s.metrics.impressions).toBeNull();
    expect(s.marksCaptured).toBe(1);
    const m = shapeSocialPostDetail(raw, "medium") as any;
    expect(m.history).toHaveLength(10);
    expect(m.content.length).toBeLessThanOrEqual(601);
  });
});

describe("account metricsStatus passthrough", () => {
  const acct = { accountId: "a", platform: "facebook", type: "page", handle: "h", status: "connected", metricsStatus: "sync_failing", metricsError: "Facebook metrics sync failed: missing pages_read_engagement permission", posts: 3 };
  it("short surfaces only a failing sync; medium always passes it", () => {
    const s = shapeSocialPerformance({ accounts: [acct, { ...acct, accountId: "b", metricsStatus: "ok", metricsError: null }] }, "short") as any;
    expect(s.accounts[0].metricsError).toContain("pages_read_engagement");
    expect(s.accounts[1].metricsStatus).toBeUndefined();
    const m = shapeSocialPerformance({ accounts: [acct] }, "medium") as any;
    expect(m.accounts[0].metricsStatus).toBe("sync_failing");
  });
});
