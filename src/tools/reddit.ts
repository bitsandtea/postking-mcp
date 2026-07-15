import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { config } from "../config.js";
import { etaFor } from "../etas.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const suggestionProj: Projector<Record<string, unknown>> = {
  short: (r) => {
    const angles = Array.isArray(r.angles) ? (r.angles as unknown[]) : [];
    const first = angles.length > 0 && angles[0] != null && typeof angles[0] === "object"
      ? (angles[0] as Record<string, unknown>)
      : null;
    return {
      subreddit: r.subreddit,
      match_score: r.match_score,
      promotion_mode: r.promotion_mode,
      buyer_intent: r.buyer_intent,
      angle: first ? { angle_type: first.angle_type, title: first.title } : null,
    };
  },
  medium: (r) => {
    const angles = Array.isArray(r.angles)
      ? (r.angles as unknown[])
          .filter((a): a is Record<string, unknown> => a != null && typeof a === "object")
          .map((a) => ({ angle_type: a.angle_type, title: a.title }))
      : [];
    return {
      subreddit: r.subreddit,
      match_score: r.match_score,
      promotion_mode: r.promotion_mode,
      buyer_intent: r.buyer_intent,
      reason: r.reason,
      rule_to_watch: r.rule_to_watch,
      angles,
    };
  },
};

export function registerRedditTools(server: McpServer) {
  // ── Get saved subreddit pool ──────────────────────────────────────────────
  server.tool(
    "reddit_get_pool",
    [
      "Returns the brand's pool of relevant subreddits — THIS IS the brand-level subreddit match (each scored).",
      "Use it to answer 'which/what/top N subreddits should my brand post in?' — NO content needed; results are sorted most-relevant first; pass `top` for a top-N list.",
      "(reddit_suggest is a different, content-specific step.)",
      "Reddit is a repurpose-to-Reddit workflow, NOT a scheduled publishing medium.",
    ].join(" "),
    {
      top: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Return only the top N most-relevant subreddits (results are always sorted most-relevant first)"),
      brandId: brandOpt,
    },
    async ({ top, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/reddit/pool`);
      const wrapper = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const pool = wrapper.pool != null && typeof wrapper.pool === "object"
        ? (wrapper.pool as Record<string, unknown>)
        : null;
      if (!pool) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              pool: null,
              message: "No subreddit pool yet. Call reddit_generate_pool first, then poll get_job until completed.",
            }),
          }],
        };
      }
      const rawSubs = Array.isArray(pool.subreddits)
        ? (pool.subreddits as unknown[]).filter((s): s is Record<string, unknown> => s != null && typeof s === "object")
        : [];
      const scoreOf = (s: Record<string, unknown>): number => {
        const combined = typeof s.combined_score === "number" ? s.combined_score : null;
        const relevance = typeof s.relevance_score === "number" ? s.relevance_score : null;
        return combined ?? relevance ?? 0;
      };
      const sorted = [...rawSubs].sort((a, b) => scoreOf(b) - scoreOf(a));
      const total = sorted.length;
      const sliced = top !== undefined ? sorted.slice(0, top) : sorted;
      const subreddits = sliced.map((s) => ({
        display_name: s.display_name != null ? String(s.display_name) : null,
        title: s.title != null ? String(s.title) : null,
        subscribers: typeof s.subscribers === "number" ? s.subscribers : null,
        relevance_score: typeof s.relevance_score === "number" ? s.relevance_score : null,
        combined_score: typeof s.combined_score === "number" ? s.combined_score : null,
        posting_style: s.posting_style != null ? String(s.posting_style) : null,
        no_promotion_reason: s.no_promotion_reason != null ? String(s.no_promotion_reason) : null,
      }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            generatedAt: pool.generatedAt ?? null,
            total,
            count: subreddits.length,
            subreddits,
          }),
        }],
      };
    }
  );

  // ── Generate subreddit pool (async) ───────────────────────────────────────
  server.tool(
    "reddit_generate_pool",
    [
      "Kick off async generation of a subreddit pool for the brand — finds relevant subreddits by crawling Reddit.",
      `Typically takes ${etaFor("brand_reddit_pool_generate")}.`,
      "Returns { operationId, status }. Poll get_job with the operationId until state=completed, then call reddit_get_pool to see results.",
      "Reddit is a repurpose-to-Reddit workflow, NOT a scheduled publishing medium.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/reddit/pool`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Global pool stats ─────────────────────────────────────────────────────
  server.tool(
    "reddit_global_pool",
    [
      "Return stats on the global subreddit dataset (count of known subreddits available for matching).",
      "Informational only — no DB writes.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/reddit/global-pool`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Suggest subreddits for content (sync, 0 credits) ──────────────────────
  server.tool(
    "reddit_suggest",
    [
      "Given a brand's content (a blog post by id, or pasted title+text), return up to 8 best-fit subreddits from the brand's pool, each with 2-3 distinct posting angles (angle type + tailored title + framing hook), plus promotion mode, buyer intent, match score, and the key rule to watch. Use an angle's title/hook to then draft a native post via reddit_rewrite.",
      "short {subreddit,match_score,promotion_mode,buyer_intent,angle} (angle = first angle only); medium adds reason,rule_to_watch,angles (all angles); full = raw.",
      "Synchronous, 0 credits.",
      "Requires the brand pool to exist — call reddit_generate_pool first if it doesn't.",
      "Flow step 2 of 4: pool → SUGGEST → rewrite → list_posts.",
    ].join(" "),
    {
      postId: z.string().optional().describe("BlogArticle ID to suggest for (use this OR title+content)"),
      title: z.string().optional().describe("Content title (required when not passing postId)"),
      content: z.string().optional().describe("Content body (optional; used with title when not passing postId)"),
      detail: detailParam("medium"),
      brandId: brandOpt,
    },
    async ({ postId, title, content, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (postId !== undefined) body.postId = postId;
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/reddit/suggest`, body);
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const items = Array.isArray(raw.suggestions)
        ? (raw.suggestions as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        : [];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: items.length,
            detail,
            suggestions: projectList(detail, items, suggestionProj),
          }),
        }],
      };
    }
  );

  // ── Rewrite content for a subreddit (async) ───────────────────────────────
  server.tool(
    "reddit_rewrite",
    [
      "Async. Rewrite a blog article (or raw content) into a Reddit-native post for a specific subreddit.",
      "Typically takes ~30–90 sec per variation.",
      "Returns quickly — if generation finishes within a short grace window, the finished Reddit post is returned inline; otherwise it returns a postId and a 'still in progress' status. Poll get_post with that postId until operationStatus is COMPLETED. Do NOT call reddit_rewrite again for the same request while it's pending.",
      "Requires pool to exist. The subreddit must be in the brand's pool.",
      "Flow step 3 of 4: pool → suggest → REWRITE → list_posts.",
    ].join(" "),
    {
      subreddit: z.string().describe("Target subreddit name (from reddit_suggest results, e.g. 'entrepreneur')"),
      voiceId: z.string().describe("Voice profile ID (use list_voices to get IDs; pass 'none' for no voice)"),
      sourcePostId: z.string().optional().describe("BlogArticle ID to rewrite (use this OR sourceContent)"),
      sourceContent: z.string().optional().describe("Raw content body to rewrite (use this OR sourcePostId)"),
      sourceTitle: z.string().optional().describe("Title of the source content (used with sourceContent)"),
      angle: z.string().optional().describe("Angle/framing for the post, e.g. 'educational', 'story' (default: 'educational')"),
      length: z.enum(["short", "medium", "long"]).optional().describe("Target post length"),
      variations: z.number().int().min(1).max(3).optional().describe("Number of variations to generate (default 1, max 3)"),
      brandId: brandOpt,
    },
    async ({ subreddit, voiceId, sourcePostId, sourceContent, sourceTitle, angle, length, variations, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { subreddit, voiceId };
      if (sourcePostId !== undefined) body.sourcePostId = sourcePostId;
      if (sourceContent !== undefined) body.sourceContent = sourceContent;
      if (sourceTitle !== undefined) body.sourceTitle = sourceTitle;
      if (angle !== undefined) body.angle = angle;
      if (length !== undefined) body.length = length;
      if (variations !== undefined) body.variations = variations;

      // The rewrite route creates a Post (not an Operation) and returns { jobId }.
      // Poll the post endpoint inline — mirrors generate_post in posts.ts. Only
      // wait up to generateGracePollMs so we never hold the MCP request open
      // longer than the remote gateway tolerates.
      const resp = await api.post<{ jobId: string }>(
        `/api/agent/v1/brands/${id}/reddit/rewrite`,
        body
      );
      const postId = resp.jobId;
      const maxAttempts = Math.ceil(config.generateGracePollMs / config.pollIntervalMs);
      let post: Record<string, unknown> = {};
      let timedOut = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
        post = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}`);
        const inner = (post.post ?? post) as Record<string, unknown>;
        const opStatus = inner.operationStatus as string | null | undefined;
        if (opStatus === "FAILED") {
          const errMsg =
            (inner.errorMessage as string | undefined) ??
            (inner.progressMessage as string | undefined) ??
            "Rewrite failed";
          throw new Error(`Reddit rewrite failed: ${errMsg}`);
        }
        if (opStatus === "COMPLETED") break;
        if (attempt === maxAttempts - 1) timedOut = true;
      }

      if (timedOut) {
        return {
          content: [{
            type: "text" as const,
            text: `Reddit rewrite still in progress. Poll get_post with postId: ${postId} until operationStatus is COMPLETED.`,
          }],
        };
      }
      const inner = (post.post ?? post) as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ postId, ...inner }) }],
      };
    }
  );

  // ── List saved reddit posts ───────────────────────────────────────────────
  server.tool(
    "reddit_list_posts",
    [
      "List saved Reddit posts (outputs of reddit_rewrite). Cursor-paginated.",
      "Returns { posts: [{ id, platform, content, outputData, sessionId, voiceId, createdAt }], nextCursor }.",
      "outputData contains: redditTitle, body, notes, wordCount, angle, length, subreddit, variationIndex.",
      "Flow step 4 of 4: pool → suggest → rewrite → LIST_POSTS.",
    ].join(" "),
    {
      cursor: z.string().optional().describe("Pagination cursor from a previous page"),
      limit: z.number().int().min(1).max(50).optional().describe("Page size (default 20, max 50)"),
      brandId: brandOpt,
    },
    async ({ cursor, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", cursor);
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/reddit/posts${suffix}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
