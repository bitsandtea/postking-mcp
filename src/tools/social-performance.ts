import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam } from "../detail.js";
import {
  SOCIAL_PERFORMANCE_PLATFORMS,
  SOCIAL_PERFORMANCE_SECTIONS,
  shapeAccountHistory,
  shapeSocialPerformance,
  shapeSocialPostDetail,
  shapeSocialPosts,
} from "./social-performance-shape.js";

/**
 * Social performance (feature 157) — free, read-only reporting over the
 * connected social accounts (LinkedIn personal + company, X, Facebook,
 * Threads, Instagram). Proxies `/api/agent/v1/brands/{id}/social-performance*`;
 * contract: PostKing docs/157-social-performance-mcp/01-api-contract.md.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");
const DAYS = z.union([z.literal(7), z.literal(28), z.literal(90), z.literal(180), z.literal(480)]);
const PLATFORM = z.enum(SOCIAL_PERFORMANCE_PLATFORMS);

const SEMANTICS =
  "null means the platform/account does not provide that metric (the reason is in `notes`/`note`); 0 means measured zero — never treat null as 0. engagementRate is a 0..1 fraction ((reactions + comments) / impressions) computed only over posts with measured impressions — `engagementRateBasis` { posts, impressions, engagements } (on summary and account rows) says what it was computed from, and totals can cover more posts: always read the rate next to the raw counts, a high rate on a handful of impressions means little. Threads currently reports no metrics at all (all null); X reactions = likes with quote tweets in `quotes`; shares/clicks are null where the platform doesn't provide them. Repeat publishes (`duplicateOf`) are excluded from totals.";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function registerSocialPerformanceTools(server: McpServer) {
  server.tool(
    "social_performance",
    [
      "Social media performance readout for the brand across all connected accounts: followers, posts published, impressions, engagements and engagementRate (each with the previous equal-length period for comparison), a Pulse score (posting activity this week vs last), per-account breakdown with connection status, top posts, a time series, and posting cadence vs target. Free, read-only. Use it for success stories, a weekly health check, and content decisions (what to post more of).",
      `Pick slices with \`sections\`: ${SOCIAL_PERFORMANCE_SECTIONS.join(", ")} (default: summary, accounts, topPosts, timeseries, cadence). Opt-in sections for "what works" questions: bottomPosts (worst measured posts, mirror of topPosts), bestTimes (UTC day-of-week x hour cells per platform, each with its post count and lowSample flag — thin cells are anecdotes, trust high-count cells), byTheme and byFormat (grouped posts, impressions, engagements, engagementRate + engagementRateBasis, medianEngagementRate; format = text|image|carousel|video|poll|reply; key null = not stored). Reach is not collected, so it is never returned. \`platform\` filters to one platform (x, facebook, linkedin = personal profile, linkedin_company, threads, instagram). \`days\` is 7, 28, 90, 180 or 480 (default 28).`,
      SEMANTICS,
      "Each account also has `metricsStatus` (ok | sync_failing | not_collected) and `metricsError`: sync_failing means post metrics are null because the metrics sync errors (e.g. Facebook missing the pages_read_engagement permission), independent of the connection `status`; tell the user and do not read the nulls as zero. Check each account's `status` (connected | token_expired | sync_failing | disconnected | session_invalid): non-connected accounts have stale numbers and need a reconnect (generate_connect_link). `previousCoverage` says whether the comparison period is fully, partly or not covered by stored follower history.",
      "detail: short (default) = headline summary, compact accounts, top 3 posts, compact cadence, no time series, and for opt-in sections the top 3 bestTimes cells per platform and top 5 byTheme/byFormat groups (cheap enough to call for many brands); medium = adds per-account detail, 5 top posts, last 12 time-series buckets, top 10 cells/groups and notes; full = the raw response. For one account's follower/post history use `social_account_history`; for a ranked, paged post list use `social_post_performance`. For search traffic use `search_performance`; for Reddit use `reddit_performance`.",
    ].join(" "),
    {
      days: DAYS.optional().default(28).describe("Lookback window in days: 7, 28, 90, 180, or 480. Default 28."),
      platform: PLATFORM.optional().describe("Restrict to one platform. Omit for all."),
      sections: z
        .array(z.enum(SOCIAL_PERFORMANCE_SECTIONS))
        .optional()
        .describe("Which slices to return. Default summary, accounts, topPosts, timeseries, cadence; add bottomPosts, bestTimes, byTheme, byFormat when needed."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ days, platform, sections, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams({ days: String(days) });
      if (platform) qs.set("platform", platform);
      if (sections && sections.length) qs.set("sections", sections.join(","));
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/social-performance?${qs.toString()}`);
      return json(shapeSocialPerformance(data, detail, sections));
    }
  );

  server.tool(
    "social_account_history",
    [
      "Follower / impressions / engagements / posts history for ONE connected social account as columnar arrays (`dates` plus one array per metric, same length), bucketed by day, week (default, UTC, weeks start Monday) or month. Use it to see growth trends and when a spike happened. Get `accountId` from `check_social_accounts` or `social_performance`. Free, read-only.",
      "Values are the last stored snapshot in each bucket (not sums), except `posts` which counts published posts. `followers` null = no snapshot in that bucket. Impressions/engagements are all-null when the platform provides no account-level numbers (see `metricsAvailable` and `notes`). " + SEMANTICS,
      "`from`/`to` are YYYY-MM-DD (default: all stored history). `metrics` limits which arrays come back (followers, impressions, engagements, posts). `limit` keeps only the most recent N buckets (default 26, max 200) unless detail=full, which returns everything.",
    ].join(" "),
    {
      accountId: z.string().min(1).describe("Connected social account ID (from check_social_accounts)."),
      granularity: z.enum(["day", "week", "month"]).optional().default("week").describe("Bucket size (default week)."),
      from: z.string().optional().describe("Earliest date, YYYY-MM-DD."),
      to: z.string().optional().describe("Latest date, YYYY-MM-DD."),
      metrics: z.array(z.enum(["followers", "impressions", "engagements", "posts"])).optional().describe("Subset of metrics to return. Default all."),
      limit: z.number().int().min(1).max(200).optional().default(26).describe("Most recent buckets to keep (default 26, max 200). Ignored at detail=full."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ accountId, granularity, from, to, metrics, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams({ granularity });
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (metrics && metrics.length) qs.set("metrics", metrics.join(","));
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/social-performance/accounts/${encodeURIComponent(accountId)}/history?${qs.toString()}`
      );
      return json(shapeAccountHistory(data, limit, detail));
    }
  );

  server.tool(
    "social_post_performance",
    [
      "Per-post social metrics (impressions, reactions, comments, shares, clicks, engagementRate) for posts published in the window — PostKing-published posts plus crawled LinkedIn company posts. Sort and page to find the best/worst performers, then decide what to post more of. Free, read-only. Each row also carries what the post was made with — theme, format (text|image|carousel|video|poll|reply), visualType and hook (first line) at detail=medium+ — so you can compare winners side by side without a call per post; null = not stored (hand-written posts, crawled posts).",
      "Pass `postId` for ONE post instead of a list: returns its metrics, what it was made with (theme + whether it is a library or custom theme, intent, hook, format, visualType + visualSource stock|generated|library|web|template|brand_asset|mixed, voice name), the platform engagement marks (T12/T24/T36/T48/T96 hours after publish, when captured) and the metric sync history. With postId, days/platform/accountId/sort/limit/offset are ignored. Example — \"which 5 posts did best last week on LinkedIn and what do they share?\": social_post_performance { days: 7, platform: \"linkedin\", sort: \"engagementRate\", limit: 5, detail: \"medium\" } (use sort impressions when LinkedIn engagement rates rest on tiny impressions), then compare theme/format/visualType/hook across the rows; call again with postId for any row you want to look into.",
      "`sort` = impressions | engagementRate | reactions | publishedAt (default publishedAt; always descending, null values last). `limit` 1-200 (default 10), `offset` for paging — the response's `pagination.hasMore` says when to stop. Filter with `platform` and/or `accountId`. `days` is 7, 28, 90, 180 or 480 (default 28).",
      SEMANTICS,
      "`shares`/`clicks` are null when the platform doesn't report them; `quotes` = X quote tweets. A post with `measuredAt: null` has never been synced (all metrics null). `deletedOnPlatform` = a LinkedIn company post deleted after we crawled it. detail: short = id, platform, date, 80-char preview and the headline metrics; medium adds accountId, postLink, shares, quotes, clicks, measuredAt, deletedOnPlatform, duplicateOf, note; full = raw.",
    ].join(" "),
    {
      postId: z.string().optional().describe("Return ONE post's performance + what it was made with (a PostKing post id, or a crawled LinkedIn company post id from this tool). Other filters are ignored."),
      days: DAYS.optional().default(28).describe("Lookback window in days: 7, 28, 90, 180, or 480. Default 28."),
      platform: PLATFORM.optional().describe("Restrict to one platform."),
      accountId: z.string().optional().describe("Only posts published from this connected account."),
      sort: z.enum(["impressions", "engagementRate", "reactions", "publishedAt"]).optional().default("publishedAt").describe("Sort field, descending, nulls last. Default publishedAt."),
      limit: z.number().int().min(1).max(200).optional().default(10).describe("Rows per page (default 10, max 200)."),
      offset: z.number().int().min(0).optional().default(0).describe("Row offset for paging (default 0)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ postId, days, platform, accountId, sort, limit, offset, detail, brandId }) => {
      const id = requireBrandId(brandId);
      if (postId) {
        const one = await api.get<unknown>(`/api/agent/v1/brands/${id}/social-performance/posts/${encodeURIComponent(postId)}`);
        return json(shapeSocialPostDetail(one, detail));
      }
      const qs = new URLSearchParams({ days: String(days), sort, limit: String(limit), offset: String(offset) });
      if (platform) qs.set("platform", platform);
      if (accountId) qs.set("accountId", accountId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/social-performance/posts?${qs.toString()}`);
      return json(shapeSocialPosts(data, detail));
    }
  );
}
