import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

/**
 * Reply drafts (feature 151): queue a Reddit comment / Quora answer for the
 * PostKing browser extension to fill in the user's own Chrome. The server is
 * only a mailbox; the extension fills the box and the user clicks submit.
 * There is deliberately no tool for filled/done — that is the extension's job.
 * Proxies `/api/agent/v1/brands/{id}/reply-drafts` and `/api/agent/v1/reply-drafts/{id}`.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const STATUSES = ["queued", "filled", "posted", "removed", "stale", "done", "failed", "cancelled"] as const;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function registerReplyDraftTools(server: McpServer) {
  // ── reply_draft_create ───────────────────────────────────────────────
  server.tool(
    "reply_draft_create",
    [
      "Queues a draft. The PostKing extension fills it in the user's browser. The user posts it.",
      "Queue a reply for a Reddit thread (comment) or a Quora question (answer). Needs the PostKing Chrome extension installed and logged in with this brand selected; it checks for queued drafts about once a minute, opens the thread, and fills the comment/answer box. Nothing is ever submitted automatically: the user reviews the text and clicks Comment/Post themselves.",
      "Max 10 drafts per brand per day (11th is refused with a 429).",
      "threadUrl: Reddit must be a thread URL like https://www.reddit.com/r/<sub>/comments/<id>/…; Quora must be a question URL like https://www.quora.com/<question-slug> (not a profile, space, topic or /answer/ link). platform must match the URL. body is 1-10,000 characters.",
      "humanize (boolean, default false): runs PostKing's anti-slop + humanizer pass on the body before it's stored; the stored text is the cleaned version. Markdown (lists, bold, links, code) is kept; if the pass fails nothing is stored. Free.",
      "Reddit only: the community's rules are checked before saving. Where links or self-promotion are not allowed, markdown links are reduced to their text and links to the brand's own site are replaced with the brand name (third-party links are left and reported). If the rules cannot be loaded, the body is saved unchanged. The result includes ruleCheck (subreddit, policy, reason, linksReplaced, linksLeft, note); read ruleCheck.note.",
      "Returns { draft, humanized, ruleCheck? } with status 'queued'. Track it with reply_drafts_list (queued → filled once the extension has filled the box, → posted once the extension finds it live on Reddit (done when marked manually), or failed with an error such as 'Thread is archived').",
    ].join(" "),
    {
      platform: z.enum(["reddit", "quora"]).describe("Where the reply goes. Must match threadUrl."),
      threadUrl: z.string().min(1).describe("Reddit thread URL (/r/<sub>/comments/<id>/…) or Quora question URL."),
      body: z.string().min(1).max(10000).describe("The reply text (markdown for Reddit), 1-10,000 characters."),
      humanize: z
        .boolean()
        .optional()
        .default(false)
        .describe("Run PostKing's anti-slop + humanizer pass on the body before it's stored. The stored text is the cleaned version."),
      brandId: brandOpt,
    },
    async ({ platform, threadUrl, body, humanize, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<{ draft?: { ruleCheck?: { note?: string | null } } | null; humanized?: boolean }>(`/api/agent/v1/brands/${id}/reply-drafts`, {
        platform,
        threadUrl,
        body,
        ...(humanize ? { humanize: true } : {}),
      });
      const ruleCheck = data?.draft?.ruleCheck ?? null;
      return json({
        queued: true,
        humanized: data?.humanized ?? false,
        draft: data?.draft ?? null,
        ...(ruleCheck?.note ? { ruleNote: ruleCheck.note } : {}),
        next: "The extension fills it within about a minute if Chrome is open. The user then reviews and posts it. Check progress with reply_drafts_list.",
      });
    }
  );

  // ── reply_drafts_list ────────────────────────────────────────────────
  server.tool(
    "reply_drafts_list",
    [
      "List the brand's reply drafts, oldest first. Free, read-only.",
      "status filter: one of queued | filled | posted | removed | stale | done | failed | cancelled, or an array of them. Omit for all. limit 1-100 (default 50).",
      "queued = waiting for the extension; filled = text is in the box, waiting for the user to post; posted = the extension found it live on Reddit; removed = mods removed it or it is hidden from the public; stale = filled over 72h ago and never found live (re-queue it); done = user marked it posted (Quora / manual); failed = see `error`; cancelled.",
    ].join(" "),
    {
      status: z
        .union([z.enum(STATUSES), z.array(z.enum(STATUSES)).min(1)])
        .optional()
        .describe("Status or list of statuses to include."),
      limit: z.number().int().min(1).max(100).optional().describe("Max drafts to return (1-100, default 50)."),
      brandId: brandOpt,
    },
    async ({ status, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const parts: string[] = [];
      if (status) parts.push(`status=${Array.isArray(status) ? status.join(",") : status}`);
      if (limit !== undefined) parts.push(`limit=${limit}`);
      const query = parts.join("&");
      const data = await api.get<{ drafts?: unknown[] }>(`/api/agent/v1/brands/${id}/reply-drafts${query ? `?${query}` : ""}`);
      const drafts = data?.drafts ?? [];
      return json({ count: drafts.length, drafts });
    }
  );

  // ── reply_draft_cancel ───────────────────────────────────────────────
  server.tool(
    "reply_draft_cancel",
    [
      "Cancel a reply draft (sets status to cancelled; terminal). Works on queued, filled or failed drafts.",
      "Cancelling does not remove text the extension already put into a Reddit/Quora box in the user's browser, and a draft that is already done cannot be cancelled (409). Get ids from reply_drafts_list.",
    ].join(" "),
    {
      draftId: z.string().min(1).describe("Draft id from reply_draft_create or reply_drafts_list."),
    },
    async ({ draftId }) => {
      const data = await api.delete<{ draft?: unknown }>(`/api/agent/v1/reply-drafts/${encodeURIComponent(draftId)}`);
      return json({ cancelled: true, draft: data?.draft ?? null });
    }
  );

  // ── reddit_performance (153) ─────────────────────────────────────────
  server.tool(
    "reddit_performance",
    [
      "How the brand's PostKing-made Reddit posts and replies are doing. Free, read-only.",
      "Data comes from the PostKing extension, which reads the user's own Reddit profile every few hours and keeps only items made from PostKing drafts (Reddit post drafts + reply drafts).",
      "days: 7 | 30 | 90 (default 7). account: optional Reddit username to filter by (the brand may have used several accounts; the result's accounts[] lists each with status active|suspended|not_found and its own stats, and is never filtered). Returns { account, accounts, sync, kpis (views, posted, upvotes, removed — each with previous period — and toPost), toPost (drafts and reply drafts still waiting, oldest first), ambiguous (posts needing the user to confirm which draft they came from), posted (each live item: subreddit, permalink, postedAt, views, upvotes, comments, status live|removed|hidden|deleted), communities (per subreddit: views, typical upvotes, removed %), byType (posts vs replies), insights }.",
      "Views exist for posts only (Reddit doesn't count views on comments). Use removals per community before suggesting where to post next. sync.lastSyncAt null means the extension hasn't synced yet.",
    ].join(" "),
    {
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional().describe("Window in days: 7, 30 or 90 (default 7)."),
      account: z.string().max(40).optional().describe("Only count items posted from this Reddit account (case-insensitive). Omit for all accounts."),
      brandId: brandOpt,
    },
    async ({ days, account, brandId }) => {
      const id = requireBrandId(brandId);
      const acc = account?.trim() ? `&account=${encodeURIComponent(account.trim())}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/reddit/performance?days=${days ?? 7}${acc}`);
      return json(data);
    }
  );
}
