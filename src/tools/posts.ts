import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { config } from "../config.js";
import { detailParam, project, projectList, type Projector } from "../detail.js";
import { generateSessionUrl, postDetailUrl, visualEditorUrl } from "../links.js";
import { languageParam } from "../languages.js";

const PLATFORMS = ["x", "linkedin", "instagram", "threads", "facebook"] as const;

function slimPost(p: Record<string, unknown>) {
  return {
    id: p.id,
    platform: p.platform,
    content: typeof p.content === "string" ? p.content.slice(0, 300) : p.content,
    status: p.status,
    scheduledAt: p.scheduledAt ?? p.postAt,
  };
}

function unwrapPosts(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.posts)) return d.posts as Record<string, unknown>[];
  }
  return [];
}

function parseVariations(outputData: unknown): { content: string }[] {
  if (!outputData) return [];
  try {
    const parsed = typeof outputData === "string" ? JSON.parse(outputData) : outputData;
    const vars = (parsed as { variations?: unknown }).variations;
    if (Array.isArray(vars)) {
      return vars
        .map((v) => (v && typeof v === "object" ? (v as { content?: unknown }).content : undefined))
        .filter((c): c is string => typeof c === "string")
        .map((content) => ({ content }));
    }
  } catch { /* not parseable — fall through */ }
  return [];
}

function summarizeVisuals(catalog: Record<string, unknown>): {
  bestPick?: Record<string, unknown>;
  options?: Record<string, unknown>[];
  note: string;
} {
  // Slim bestPick: keep slot/kind/displayLabel/pickArgs
  let bestPick: Record<string, unknown> | undefined;
  const bp = catalog.bestPick;
  if (bp && typeof bp === "object" && !Array.isArray(bp)) {
    const b = bp as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    for (const k of ["slot", "kind", "displayLabel", "pickArgs"] as const) {
      if (b[k] !== undefined) slim[k] = b[k];
    }
    if (Object.keys(slim).length) bestPick = slim;
  }

  // Flatten option items from the catalog (skip bestPick key, recurse into options)
  const KEEP_KEYS = ["slot", "kind", "style", "variant", "displayLabel", "recommended", "pickArgs", "previewUrl"] as const;
  function slimItem(item: Record<string, unknown>): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    for (const k of KEEP_KEYS) {
      if (item[k] !== undefined) s[k] = item[k];
    }
    return s;
  }
  function collectItems(val: unknown, visited = new WeakSet<object>()): Record<string, unknown>[] {
    if (!val || typeof val !== "object") return [];
    if (visited.has(val as object)) return [];
    visited.add(val as object);
    if (Array.isArray(val)) {
      const out: Record<string, unknown>[] = [];
      for (const item of val) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const it = item as Record<string, unknown>;
          if ("slot" in it || "kind" in it || "pickArgs" in it) {
            out.push(slimItem(it));
          } else {
            out.push(...collectItems(item, visited));
          }
        }
      }
      return out;
    }
    const d = val as Record<string, unknown>;
    const out: Record<string, unknown>[] = [];
    for (const [key, v] of Object.entries(d)) {
      if (key === "bestPick") continue;
      out.push(...collectItems(v, visited));
    }
    return out;
  }

  const allItems = collectItems(catalog);
  const options = allItems.slice(0, 8);

  return {
    ...(bestPick ? { bestPick } : {}),
    ...(options.length ? { options } : {}),
    note: "Visual options (quote templates, card templates, brand images, stock photos) were prepared but NOT attached to the post. Nothing is added until the user picks one. To attach a chosen option, call pick_post_visual with its pickArgs verbatim (kind + style + variant for templates, or assetId/slot for library/smart/photo assets). The user can preview all options visually at viewInBrowser.",
  };
}

const postProjector: Projector<Record<string, unknown>> = {
  short: (p) => ({ id: p.id, status: p.status, scheduledAt: p.scheduledAt ?? p.postAt }),
  medium: slimPost,
};

export function registerPostTools(server: McpServer) {
  // ── Generate post (AI) ────────────────────────────────────────────────────
  server.tool(
    "generate_post",
    [
      "Generate AI content for a platform. Returns quickly with a postId and a 'generating' or 'completed' status — it does NOT block until generation fully finishes. Deducts 10 credits per variation.",
      "To control what the post is about, pass `theme` with a free-text brief (any topic/angle/facts/tone). If you omit `theme`, the topic is RANDOM — so always pass it when the user wants specific content.",
      "When variations > 1, ALL variations are returned under a SINGLE postId in the `variations` array — it does NOT create one post per variation. `content` is variation 1 (the primary, already saved on the post). Never call generate_post again to 'get the other variations' — they're all in the response.",
      "`originalContent` (if seen elsewhere) is the pre-voice-rewrite draft, not a separate variation.",
      "After generating, use create_post to save a chosen variation, then approve_post to schedule it.",
      "To repurpose: call repurpose_content first, then create_post with the result, then approve_post.",
      "Generation can take 1-5 minutes (longer with multiple variations or voice rewrite). This tool only waits a short grace period so fast generations can return inline content; if it returns status 'generating', the job is still running server-side — poll get_post with the returned postId until operationStatus is 'completed', then use that content. Do NOT call generate_post again for the same request while it's pending — retrying creates a duplicate draft and wastes credits.",
      "After generation, brand visual options (quote/card templates, brand images, stock photos) are prepared but NOT attached — share viewInBrowser for the visual picker, or call pick_post_visual to attach one. Do not attach a visual unless the user chooses it.",
      "The response includes editInVisualEditor: a direct URL to edit the post in the visual editor (once completed).",
    ].join(" "),
    {
      platform: z
        .string()
        .describe("Platform: x | linkedin | instagram | threads | facebook | custom:<charLimit>"),
      variations: z.number().min(1).max(5).optional().default(1).describe("Number of variations to generate"),
      theme: z.string().optional().describe("Free-text topic/brief describing what the post should be about — include any angle, emphasis, key facts, or tone (e.g. \"Launch announcement for our new MCP; emphasize NVIDIA + Stripe + Amotron; B2B authoritative tone\"). ALWAYS pass this when the user wants the post to be about something specific. If omitted, a RANDOM brand theme is used and the topic will NOT match the user's request."),
      themeId: z.string().optional().describe("Optional ID of a saved brand theme (from list_themes). Most callers should pass the free-text `theme` instead. If both are given, the free-text `theme` wins."),
      voice: z.string().optional().describe("Voice profile ID to apply"),
      language: languageParam("Set the brand's standing language with set_brand_content_language instead when every future generation should use it."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platform, variations, theme, themeId, voice, language, brandId }) => {
      const id = requireBrandId(brandId);
      const customTheme = typeof theme === "string" && theme.trim().length > 0 ? theme.trim() : undefined;

      const resp = await api.post<{ postId: string; sessionId?: string; pollUrl?: string }>(
        `/api/agent/v1/brands/${id}/posts/generate`,
        {
          medium: platform,
          variationCount: variations,
          themeId: !customTheme && themeId ? themeId : undefined,
          customTheme,
          randomTheme: !customTheme && !themeId,
          voiceProfileId: voice,
          // Omitted when the caller said nothing, so the server can tell
          // "no override" from an explicit "en" (JSON.stringify drops undefined).
          language,
          assignAsset: false,
        }
      );

      const postId = resp.postId;
      const sessionId = resp.sessionId;
      const viewInBrowser = sessionId ? generateSessionUrl(id, sessionId) : undefined;
      const maxAttempts = Math.ceil(config.generateGracePollMs / config.pollIntervalMs);
      let post: Record<string, unknown> = {};
      let completed = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
        post = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}`);
        const inner = (post.post ?? post) as Record<string, unknown>;
        const opStatus = inner.operationStatus as string | null | undefined;
        if (opStatus === "FAILED") {
          const errMsg = (inner.errorMessage as string | undefined) ?? "Generation failed";
          throw new Error(`Post generation failed: ${errMsg}`);
        }
        if (opStatus === "COMPLETED") {
          completed = true;
          break;
        }
        if (!opStatus && inner.content) {
          completed = true;
          break;
        }
      }

      if (!completed) {
        // Grace window elapsed but the job is still running server-side — do not
        // hold the MCP request open any longer. The caller must poll get_post.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "generating",
                postId,
                ...(sessionId ? { sessionId } : {}),
                ...(viewInBrowser ? { viewInBrowser } : {}),
                message:
                  "Generation is in progress and will finish server-side. Poll it with get_post using this postId. Do NOT call generate_post again for this request — retrying will create duplicate drafts.",
              }),
            },
          ],
        };
      }

      const inner = (post.post ?? post) as Record<string, unknown>;
      let visuals: { bestPick?: Record<string, unknown>; options?: Record<string, unknown>[]; note: string } | undefined;
      try {
        await api.post(`/api/agent/v1/posts/${postId}/visuals/regenerate`, { loadExternal: true });
        const catalog = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/visuals`);
        visuals = summarizeVisuals(catalog);
      } catch {
        // visual options are best-effort; never block returning the generated content
      }
      const parsedVariations = parseVariations(inner.outputData);
      const editInVisualEditor = visualEditorUrl(id, postId, typeof inner.platform === "string" ? inner.platform : platform);
      const result = {
        postId,
        platform: inner.platform,
        status: inner.status,
        // All variations live on this ONE postId. content is variation 1 (the primary, already saved on the post).
        variationCount: Math.max(parsedVariations.length, 1),
        content: inner.content,
        variations: parsedVariations.length
          ? parsedVariations.map((v, i) => ({ index: i + 1, content: v.content }))
          : undefined,
        note:
          parsedVariations.length > 1
            ? `${parsedVariations.length} variations were generated under this single postId. 'content' is variation 1 (already saved). The alternatives are in the 'variations' array. To use a different one, update the post content or save it with create_post. Do NOT call generate_post again — all variations are already here.`
            : undefined,
        ...(viewInBrowser ? { viewInBrowser } : {}),
        editInVisualEditor,
        ...(visuals ? { visuals } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Generate bulk posts ───────────────────────────────────────────────────
  server.tool(
    "generate_bulk_posts",
    "Generate and schedule multiple posts across a date range in the background.",
    {
      platform: z.string().describe("Platform: x | linkedin | instagram | threads | facebook"),
      days: z.number().min(1).max(90).describe("Number of days to fill"),
      frequency: z
        .enum(["daily", "every_other", "every_third", "weekdays"])
        .optional()
        .default("daily")
        .describe("Posting frequency"),
      postsPerDay: z.number().min(1).max(5).optional().default(1),
      times: z
        .string()
        .optional()
        .default("09:00")
        .describe("Comma-separated posting times, e.g. '09:00,14:00'"),
      voice: z.string().optional().describe("Voice profile ID"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platform, days, frequency, postsPerDay, times, voice, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/brands/${id}/posts/generate-batch`, {
        platform,
        days,
        frequency,
        postsPerDay,
        times: times?.split(",").map((t) => t.trim()),
        voiceProfileId: voice,
      });
      const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const slim: Record<string, unknown> = {};
      if (d.operationId !== undefined) slim.operationId = d.operationId;
      if (d.totalQueued !== undefined) slim.totalQueued = d.totalQueued;
      if (d.pollUrl !== undefined) slim.pollUrl = d.pollUrl;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim) }],
      };
    }
  );

  // ── Create post (manual) ──────────────────────────────────────────────────
  server.tool(
    "create_post",
    [
      "Save a post draft with custom content to one or more platforms.",
      "Supported platforms: x, linkedin, instagram, threads, facebook.",
      "After creating, call approve_post with a future ISO 8601 datetime to schedule it.",
      "To check which platforms are connected first, call check_social_accounts.",
      "Each created post includes editInVisualEditor: a direct URL to edit it in the visual editor.",
    ].join(" "),
    {
      platforms: z
        .array(z.enum(PLATFORMS))
        .describe("One or more platforms: x | linkedin | instagram | threads | facebook"),
      content: z.string().describe("Post content"),
      scheduledAt: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601 UTC datetime to schedule immediately on save, e.g. 2026-03-11T09:00:00Z"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platforms, content, scheduledAt, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/posts/manual`, {
        content,
        platforms,
        postType: scheduledAt ? "scheduled" : "queue",
        scheduledAt,
      });
      const posts = unwrapPosts(data);
      return {
        content: [
          {
            type: "text" as const,
            text: posts.length
              ? `Created ${posts.length} post(s):\n${JSON.stringify(posts.map((p) => ({
                  ...slimPost(p),
                  ...(typeof p.id === "string" && typeof p.platform === "string"
                    ? { editInVisualEditor: visualEditorUrl(id, p.id as string, p.platform as string) }
                    : {}),
                })), null, 2)}`
              : JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  // ── List posts ────────────────────────────────────────────────────────────
  server.tool(
    "list_posts",
    "List recent posts and drafts. Filter by status or platform. Use status='created' to find unscheduled drafts. Returns id+status+scheduledAt by default; use detail='medium' or 'full' for more fields. For a single post use get_post.",
    {
      status: z.enum(["created", "approved", "scheduled", "posted", "failed", "cancelled", "disapproved"]).optional(),
      platform: z.enum(PLATFORMS).optional(),
      limit: z.number().min(1).max(100).optional().default(10),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("short"),
    },
    async ({ status, platform, limit, brandId, detail }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (platform) params.set("platform", platform);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/posts${qs}`);
      const posts = unwrapPosts(data);
      const text = JSON.stringify({ count: posts.length, detail, posts: projectList(detail, posts, postProjector) });
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  // ── View post ─────────────────────────────────────────────────────────────
  server.tool(
    "get_post",
    "View the full content and status of a single post. Use detail='short'|'medium'|'full' to control verbosity (default full). Multi-variation posts expose a `variations` array (all variations live on one postId). Output shows the final voice-rewritten content by default; pass includeOriginal=true to also see the pre-rewrite draft. Includes contentReviewUrl: a direct link to read and approve the generated body, and editInVisualEditor: a direct URL to edit the post in the visual editor.",
    {
      postId: z.string().describe("Post ID"),
      detail: detailParam("full"),
      includeOriginal: z.boolean().optional().default(false).describe("Include the pre-voice-rewrite original draft (originalContent). Default false — you normally want the rewritten voice content."),
    },
    async ({ postId, detail, includeOriginal }) => {
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}`);
      const raw = data as Record<string, unknown>;
      const post = (raw.post && typeof raw.post === "object" ? raw.post : raw) as Record<string, unknown>;
      const projected = project(detail, post, postProjector) as Record<string, unknown>;
      if (detail !== "short") {
        const variations = parseVariations(post.outputData);
        if (variations.length > 1) {
          projected.variationCount = variations.length;
          projected.variations = variations.map((v, i) => ({ index: i + 1, content: v.content }));
        }
      }
      if (!includeOriginal) {
        delete projected.originalContent;
      }
      if (detail !== "short") {
        if (typeof raw.webUrl === "string") {
          projected.contentReviewUrl = raw.webUrl;
        } else if (typeof post.brandId === "string") {
          projected.contentReviewUrl = postDetailUrl(post.brandId, postId);
        }
      }
      if (typeof post.brandId === "string" && typeof post.platform === "string") {
        projected.editInVisualEditor = visualEditorUrl(post.brandId, postId, post.platform);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projected) }],
      };
    }
  );

  // ── Approve post ──────────────────────────────────────────────────────────
  server.tool(
    "approve_post",
    [
      "Approve and schedule a draft post. Requires a future datetime.",
      "The scheduledAt must be an ISO 8601 UTC datetime, e.g. 2026-03-11T09:00:00Z.",
      "After approving, the post status becomes 'scheduled'.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID to approve"),
      scheduledAt: z.string().datetime().describe("Future ISO 8601 UTC datetime to post at"),
      timezone: z.string().optional().describe("User timezone, e.g. 'America/New_York'"),
    },
    async ({ postId, scheduledAt, timezone }) => {
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/approve`, {
        postAt: scheduledAt,
        userTimezone: timezone,
      });
      const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const inner = (d.post && typeof d.post === "object" ? d.post : d) as Record<string, unknown>;
      const confirmation: Record<string, unknown> = {
        postId: (inner.id as string | undefined) ?? postId,
        status: inner.status,
      };
      if (inner.scheduledAt !== undefined) confirmation.scheduledAt = inner.scheduledAt;
      else if (inner.postAt !== undefined) confirmation.scheduledAt = inner.postAt;
      if (inner.webUrl !== undefined) confirmation.webUrl = inner.webUrl;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(confirmation) }],
      };
    }
  );

  // ── Reschedule post ───────────────────────────────────────────────────────
  server.tool(
    "reschedule_post",
    "Move a scheduled post to a new time. Pass a future ISO 8601 UTC datetime.",
    {
      postId: z.string().describe("Post ID to reschedule"),
      scheduledAt: z.string().datetime().describe("New future ISO 8601 UTC datetime"),
    },
    async ({ postId, scheduledAt }) => {
      const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/posts/${postId}`, { scheduledAt });
      const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const inner = (d.post && typeof d.post === "object" ? d.post : d) as Record<string, unknown>;
      const confirmation: Record<string, unknown> = {
        postId: (inner.id as string | undefined) ?? postId,
        status: inner.status,
      };
      if (inner.scheduledAt !== undefined) confirmation.scheduledAt = inner.scheduledAt;
      else if (inner.postAt !== undefined) confirmation.scheduledAt = inner.postAt;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(confirmation) }],
      };
    }
  );

  // ── Schedule post (alias: approve with time) ──────────────────────────────
  server.tool(
    "schedule_post",
    [
      "Schedule a draft or approved post for a specific time. Equivalent to approve_post but named to match 'pking posts schedule'.",
      "Pass a future ISO 8601 UTC datetime. After scheduling the post status becomes 'scheduled'.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID to schedule"),
      scheduledAt: z.string().datetime().describe("Future ISO 8601 UTC datetime, e.g. 2026-06-01T09:00:00Z"),
      timezone: z.string().optional().describe("User timezone, e.g. 'America/New_York'"),
    },
    async ({ postId, scheduledAt, timezone }) => {
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/approve`, {
        postAt: scheduledAt,
        userTimezone: timezone,
      });
      const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const inner = (d.post && typeof d.post === "object" ? d.post : d) as Record<string, unknown>;
      const confirmation: Record<string, unknown> = {
        postId: (inner.id as string | undefined) ?? postId,
        status: inner.status,
      };
      if (inner.scheduledAt !== undefined) confirmation.scheduledAt = inner.scheduledAt;
      else if (inner.postAt !== undefined) confirmation.scheduledAt = inner.postAt;
      if (inner.webUrl !== undefined) confirmation.webUrl = inner.webUrl;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(confirmation) }],
      };
    }
  );

  // ── Cancel post ───────────────────────────────────────────────────────────
  server.tool(
    "cancel_post",
    "Cancel a scheduled or approved post, reverting it to draft status without deleting it. Use delete_post to remove it entirely.",
    {
      postId: z.string().describe("Post ID to cancel"),
    },
    async ({ postId }) => {
      const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/posts/${postId}`, { action: "cancel" });
      const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const inner = (d.post && typeof d.post === "object" ? d.post : d) as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ postId: (inner.id as string | undefined) ?? postId, status: inner.status }) }],
      };
    }
  );

  // ── Cancel / delete post ──────────────────────────────────────────────────
  server.tool(
    "delete_post",
    "Cancel and delete a post regardless of its current status (draft, scheduled, or posted).",
    { postId: z.string().describe("Post ID to delete") },
    async ({ postId }) => {
      await api.delete(`/api/agent/v1/posts/${postId}`);
      return {
        content: [{ type: "text" as const, text: `Post ${postId} deleted.` }],
      };
    }
  );

  // ── Calendar ──────────────────────────────────────────────────────────────
  server.tool(
    "get_calendar",
    "View upcoming scheduled posts sorted by date. Returns id+status+scheduledAt by default; use detail='medium' or 'full' for more fields. For a single post use get_post.",
    {
      days: z.number().min(1).max(90).optional().default(14).describe("How many days ahead to show"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("short"),
    },
    async ({ days, brandId, detail }) => {
      const id = requireBrandId(brandId);
      const from = new Date().toISOString();
      const to = new Date(Date.now() + days * 86_400_000).toISOString();
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/posts?status=scheduled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`
      );
      const posts = unwrapPosts(data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: posts.length, detail, posts: projectList(detail, posts, postProjector) }) }],
      };
    }
  );
}
