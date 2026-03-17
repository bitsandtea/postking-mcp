import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { pollUntilDone } from "../poll.js";
import { requireBrandId } from "../state.js";

const PLATFORMS = ["x", "linkedin", "instagram", "threads", "facebook"] as const;

function slimPost(p: any) {
  return {
    id: p.id,
    platform: p.platform,
    content: typeof p.content === "string" ? p.content.slice(0, 300) : p.content,
    status: p.status,
    scheduledAt: p.scheduledAt ?? p.postAt,
  };
}

function unwrapPosts(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data?.posts && Array.isArray(data.posts)) return data.posts;
  return [];
}

export function registerPostTools(server: McpServer) {
  // ── Generate post (AI) ────────────────────────────────────────────────────
  server.tool(
    "generate_post",
    [
      "Generate AI content for a platform. Polls until complete. Deducts 10 credits per variation.",
      "After generating, use create_post to save it, then approve_post to schedule it.",
      "To repurpose: call repurpose_content first, then create_post with the result, then approve_post.",
    ].join(" "),
    {
      platform: z
        .string()
        .describe("Platform: x | linkedin | instagram | threads | facebook | custom:<charLimit>"),
      variations: z.number().min(1).max(5).optional().default(1).describe("Number of variations to generate"),
      theme: z.string().optional().describe("Theme ID or name (random theme used if omitted)"),
      voice: z.string().optional().describe("Voice profile ID to apply"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platform, variations, theme, voice, brandId }) => {
      const id = requireBrandId(brandId);

      const { postId, pollUrl } = await api.post<{ postId: string; pollUrl: string }>(
        `/api/brands/${id}/generate-content/async`,
        {
          medium: platform,
          variationCount: variations,
          themeId: theme?.startsWith("cl") ? theme : undefined,
          customTheme: theme && !theme.startsWith("cl") ? theme : undefined,
          randomTheme: !theme,
          voiceProfileId: voice,
          assignAsset: false,
        }
      );

      const post = await pollUntilDone<Record<string, unknown>>(pollUrl);

      let result: unknown = post;
      if (typeof post.outputData === "string") {
        try {
          const parsed = JSON.parse(post.outputData);
          result = { postId, content: post.content, ...parsed };
        } catch {
          result = { postId, content: post.content };
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
      const data = await api.post(`/api/brands/${id}/generate-batch`, {
        platform,
        days,
        frequency,
        postsPerDay,
        times: times?.split(",").map((t) => t.trim()),
        voiceProfileId: voice,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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
      const data = await api.post<any>(`/api/brands/${id}/posts/manual`, {
        content,
        platforms,
        postType: scheduledAt ? "scheduled" : "draft",
        scheduledAt,
      });
      const posts = unwrapPosts(data);
      return {
        content: [
          {
            type: "text" as const,
            text: posts.length
              ? `Created ${posts.length} post(s):\n${JSON.stringify(posts.map(slimPost), null, 2)}`
              : JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  // ── List posts ────────────────────────────────────────────────────────────
  server.tool(
    "list_posts",
    "List recent posts and drafts. Filter by status or platform. Use status='created' to find unscheduled drafts.",
    {
      status: z.enum(["created", "scheduled", "posted"]).optional(),
      platform: z.enum(PLATFORMS).optional(),
      limit: z.number().min(1).max(100).optional().default(10),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, platform, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (platform) params.set("platform", platform);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/brands/${id}/posts${qs}`);
      const slim = unwrapPosts(data).map(slimPost);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );

  // ── View post ─────────────────────────────────────────────────────────────
  server.tool(
    "get_post",
    "View the full content and status of a single post.",
    { postId: z.string().describe("Post ID") },
    async ({ postId }) => {
      const data = await api.get<any>(`/api/posts/${postId}`);
      const post = data?.post ?? data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimPost(post), null, 2) }],
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
      const data = await api.post(`/api/posts/${postId}/approve`, {
        postAt: scheduledAt,
        userTimezone: timezone,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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
      const data = await api.patch(`/api/posts/${postId}`, { scheduledAt });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Cancel / delete post ──────────────────────────────────────────────────
  server.tool(
    "delete_post",
    "Cancel and delete a post regardless of its current status (draft, scheduled, or posted).",
    { postId: z.string().describe("Post ID to delete") },
    async ({ postId }) => {
      await api.delete(`/api/posts/${postId}`);
      return {
        content: [{ type: "text" as const, text: `Post ${postId} deleted.` }],
      };
    }
  );

  // ── Calendar ──────────────────────────────────────────────────────────────
  server.tool(
    "get_calendar",
    "View upcoming scheduled posts sorted by date.",
    {
      days: z.number().min(1).max(90).optional().default(14).describe("How many days ahead to show"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ days, brandId }) => {
      const id = requireBrandId(brandId);
      const from = new Date().toISOString();
      const to = new Date(Date.now() + days * 86_400_000).toISOString();
      const data = await api.get<any>(
        `/api/brands/${id}/posts?status=scheduled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`
      );
      const slim = unwrapPosts(data).map(slimPost);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );
}
