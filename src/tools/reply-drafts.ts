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

const STATUSES = ["queued", "filled", "done", "failed", "cancelled"] as const;

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
      "Returns { draft, humanized } with status 'queued'. Track it with reply_drafts_list (queued → filled once the extension has filled the box, → done when the user marks it posted, or failed with an error such as 'Thread is archived').",
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
      const data = await api.post<{ draft?: unknown; humanized?: boolean }>(`/api/agent/v1/brands/${id}/reply-drafts`, {
        platform,
        threadUrl,
        body,
        ...(humanize ? { humanize: true } : {}),
      });
      return json({
        queued: true,
        humanized: data?.humanized ?? false,
        draft: data?.draft ?? null,
        next: "The extension fills it within about a minute if Chrome is open. The user then reviews and posts it. Check progress with reply_drafts_list.",
      });
    }
  );

  // ── reply_drafts_list ────────────────────────────────────────────────
  server.tool(
    "reply_drafts_list",
    [
      "List the brand's reply drafts, oldest first. Free, read-only.",
      "status filter: one of queued | filled | done | failed | cancelled, or an array of them. Omit for all. limit 1-100 (default 50).",
      "queued = waiting for the extension; filled = text is in the box, waiting for the user to post; done = user posted; failed = see `error`; cancelled.",
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
}
