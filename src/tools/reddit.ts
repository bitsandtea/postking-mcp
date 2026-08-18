import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { config } from "../config.js";
import { etaFor } from "../etas.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, truncate, type Projector } from "../detail.js";

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

const discoveryProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    display_name: r.display_name,
    subscribers: r.subscribers,
    already_in_pool: r.already_in_pool,
  }),
  medium: (r) => ({
    display_name: r.display_name,
    title: r.title,
    public_description: truncate(r.public_description, 200),
    subscribers: r.subscribers,
    found_via: r.found_via,
    already_cached: r.already_cached,
    already_in_pool: r.already_in_pool,
  }),
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
      "Async. Rewrite a blog article (or raw content) into a Reddit-native post for one subreddit (`subreddit`) or several at once (`subreddits`) — multiple subreddits fan out to N drafts, one per subreddit.",
      "Typically takes ~30–90 sec per variation.",
      "Every subreddit in the batch is auto-added to the brand's pool at rewrite time — before any draft is reviewed — so use reddit_remove_from_pool to prune subs the user decides against. Billing stays 10 credits per draft: N subreddits = N×10 credits.",
      "Returns quickly — if generation finishes within a short grace window, the finished Reddit post is returned inline; otherwise it returns a postId and a 'still in progress' status. Poll get_post with that postId until operationStatus is COMPLETED. Do NOT call reddit_rewrite again for the same request while it's pending.",
      "The subreddit does NOT need to be in the brand's pool — if it isn't, the rewrite still proceeds using general Reddit best-practices, and the result includes a `subredditNotice` string flagging that this subreddit hasn't been onboarded yet.",
      "Flow step 3 of 4: pool → suggest → REWRITE → list_posts.",
    ].join(" "),
    {
      subreddit: z.string().optional().describe("Single target subreddit name (legacy one-element alias; e.g. 'entrepreneur'). Pass this OR `subreddits`."),
      subreddits: z.array(z.string().min(1)).min(1).optional().describe("Target subreddit names — fans out to one draft per subreddit (e.g. from reddit_discover_subreddits picks). Pass this OR `subreddit`."),
      voiceId: z.string().optional().describe("Voice profile ID (use list_voices to get IDs; pass 'none' for no voice)"),
      sourcePostId: z.string().optional().describe("BlogArticle ID to rewrite (use this OR sourceContent)"),
      sourceContent: z.string().optional().describe("Raw content body to rewrite (use this OR sourcePostId)"),
      sourceTitle: z.string().optional().describe("Title of the source content (used with sourceContent)"),
      angle: z.string().optional().describe("Angle/framing for the post, e.g. 'educational', 'story' (default: 'educational')"),
      length: z.enum(["short", "medium", "long"]).optional().describe("Target post length"),
      variations: z.number().int().min(1).max(3).optional().describe("Number of variations to generate (default 1, max 3)"),
      brandId: brandOpt,
    },
    async ({ subreddit, subreddits, voiceId, sourcePostId, sourceContent, sourceTitle, angle, length, variations, brandId }) => {
      const id = requireBrandId(brandId);
      if (subreddit === undefined && subreddits === undefined) {
        throw new Error("Provide either `subreddit` (single) or `subreddits` (fan-out to one draft per subreddit).");
      }
      const body: Record<string, unknown> = {};
      if (subreddit !== undefined) body.subreddit = subreddit;
      if (subreddits !== undefined) body.subreddits = subreddits;
      if (voiceId !== undefined) body.voiceId = voiceId;
      if (sourcePostId !== undefined) body.sourcePostId = sourcePostId;
      if (sourceContent !== undefined) body.sourceContent = sourceContent;
      if (sourceTitle !== undefined) body.sourceTitle = sourceTitle;
      if (angle !== undefined) body.angle = angle;
      if (length !== undefined) body.length = length;
      if (variations !== undefined) body.variations = variations;

      // The rewrite route creates a Post (not an Operation) and returns { jobId }.
      // It also returns `subredditNotice` (only when the target subreddit
      // isn't in the brand's pool yet) — captured here at kickoff since it's
      // computed synchronously in the route before the background job runs.
      // Poll the post endpoint inline — mirrors generate_post in posts.ts. Only
      // wait up to generateGracePollMs so we never hold the MCP request open
      // longer than the remote gateway tolerates.
      const resp = await api.post<{ jobId: string; subredditNotice?: string }>(
        `/api/agent/v1/brands/${id}/reddit/rewrite`,
        body
      );
      const postId = resp.jobId;
      const subredditNotice = resp.subredditNotice;
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
        const noticeSuffix = subredditNotice ? `\n\n${subredditNotice}` : "";
        return {
          content: [{
            type: "text" as const,
            text: `Reddit rewrite still in progress. Poll get_post with postId: ${postId} until operationStatus is COMPLETED.${noticeSuffix}`,
          }],
        };
      }
      const inner = (post.post ?? post) as Record<string, unknown>;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ postId, ...inner, ...(subredditNotice ? { subredditNotice } : {}) }),
        }],
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

  // ── Discover subreddits by user-directed search (sync, 15 credits) ────────
  server.tool(
    "reddit_discover_subreddits",
    [
      "Search Reddit for subreddits in any direction the user chooses — this is how you find communities BEYOND the brand-signal pool (reddit_generate_pool only uses brand signals; this takes explicit queries).",
      "Pass 1-8 search queries. Returns a ranked list sorted by subscribers desc, each row flagged already_in_pool (already in THIS brand's pool) and already_cached (already known to the platform), with found_via listing which queries surfaced it. NSFW and non-public subreddits are always excluded.",
      "A good `context` string is what disambiguates ambiguous queries — e.g. 'hermes' the AI-agent framework vs the fashion brand vs parcel delivery. Describe what the brand actually wants and what to exclude. `minSubs` (minimum subscriber count) defaults to 0 — no floor — so tiny high-intent niche communities are kept; raise it only if the user wants bigger communities.",
      "Costs 15 credits per call, flat, regardless of cache state (the relevance filter always runs fresh against your context).",
      "short {display_name,subscribers,already_in_pool}; medium adds title, truncated public_description, found_via, already_cached; full = raw.",
      "Flow: DISCOVER → user picks → either reddit_add_to_pool with the chosen names, or go straight to reddit_rewrite for the chosen subreddit(s) — rewriting for a subreddit auto-adds it to the pool. Prune any time with reddit_remove_from_pool.",
    ].join(" "),
    {
      queries: z
        .array(z.string().min(1))
        .min(1)
        .max(8)
        .describe("1-8 search queries, e.g. ['ai agents', 'mcp', 'llm tools']. Each is searched against Reddit's subreddit index."),
      context: z
        .string()
        .optional()
        .describe("Free-text disambiguation: what the brand wants and what to exclude (e.g. 'Hermes the AI agent framework — NOT the fashion brand, NOT parcel delivery'). Strongly recommended for ambiguous queries."),
      minSubs: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Minimum subscriber count. Default 0 (no floor) — keeps small niche communities."),
      detail: detailParam("medium"),
      brandId: brandOpt,
    },
    async ({ queries, context, minSubs, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { queries };
      if (context !== undefined) body.context = context;
      if (minSubs !== undefined) body.minSubs = minSubs;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/reddit/discover`, body);
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const list = Array.isArray(raw.subreddits)
        ? raw.subreddits
        : Array.isArray(raw.results)
          ? raw.results
          : Array.isArray(data)
            ? (data as unknown[])
            : [];
      const rows = (list as unknown[]).filter(
        (r): r is Record<string, unknown> => r != null && typeof r === "object"
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: rows.length,
            creditsCharged: raw.creditsCharged,
            detail,
            subreddits: projectList(detail, rows, discoveryProj),
          }),
        }],
      };
    }
  );

  // ── Add subreddits to the brand pool (sync, 0 credits) ────────────────────
  server.tool(
    "reddit_add_to_pool",
    [
      "Add subreddits to the brand's pool by name (1-25 per call). Free — 0 credits.",
      "Each name is resolved live from Reddit (about + rules) and merged into the brand's pool; already-present names are updated in place.",
      "PARTIAL SUCCESS IS NORMAL: names that can't resolve (private/banned/nonexistent) come back in failed: [{ name, reason }] while the rest still commit. A non-empty failed list is NOT an error — report which names were added and which failed, and why.",
      "Typical source: names the user picked from reddit_discover_subreddits results. Not required before reddit_rewrite — rewriting for an off-pool subreddit auto-adds it to the pool.",
    ].join(" "),
    {
      names: z
        .array(z.string().min(1))
        .min(1)
        .max(25)
        .describe("Subreddit display names to add, e.g. ['hermesagent', 'AI_Agents'] (no 'r/' prefix needed; case-insensitive)"),
      brandId: brandOpt,
    },
    async ({ names, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/reddit/pool/add`, { names });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Remove subreddits from the brand pool (sync, 0 credits) ───────────────
  server.tool(
    "reddit_remove_from_pool",
    [
      "Remove subreddits from the brand's pool by name (1-50 per call, case-insensitive). Free — 0 credits.",
      "Brand-scoped un-subscribe ONLY — it never touches the platform's global subreddit cache, so re-adding later is cheap.",
      "Names not present in the pool come back in notFound: string[] — that is still success, not an error; the rest are removed.",
      "Use it to prune after a reddit_rewrite fan-out auto-added subreddits the user no longer wants, or any time the pool needs curating.",
    ].join(" "),
    {
      names: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Subreddit display names to remove, e.g. ['hermesagent'] (no 'r/' prefix needed; case-insensitive)"),
      brandId: brandOpt,
    },
    async ({ names, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/reddit/pool/remove`, { names });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
