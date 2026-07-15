import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { pollUntilDone } from "../poll.js";
import { requireBrandId, setActiveBrandId, getActiveBrandId } from "../state.js";
import { detailParam, projectList, truncate, type Projector } from "../detail.js";

function slimBrand(b: any) {
  return { id: b.id, name: b.name, website: b.website, description: b.description };
}
function slimTheme(t: any) {
  return { id: t.id, title: t.title, content: typeof t.content === "string" ? t.content.slice(0, 200) : t.content };
}

export function registerBrandTools(server: McpServer) {
  // ── List brands ──────────────────────────────────────────────────────────
  server.tool(
    "list_brands",
    "List all brands on your PostKing account. Returns id+name+website by default (short). Use detail='medium' for description, 'full' for all raw fields. To zoom into one brand call get_brand_info with detail='full'.",
    {
      detail: detailParam("short"),
    },
    async ({ detail }) => {
      const data = await api.get<{ brands?: unknown[] }>("/api/agent/v1/brands");
      const raw = (Array.isArray(data) ? data : (data.brands ?? [data])) as Record<string, unknown>[];
      const active = getActiveBrandId();
      const proj: Projector<Record<string, unknown>> = {
        short: (b) => ({ id: b.id, name: b.name, website: b.website }),
        medium: (b) => slimBrand(b),
      };
      const result = { count: raw.length, detail, activeBrandId: active, brands: projectList(detail, raw, proj) };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  // ── Set active brand ──────────────────────────────────────────────────────
  server.tool(
    "set_active_brand",
    "Set the active brand for this session. All subsequent tools will use this brand by default.",
    { brandId: z.string().describe("The brand ID to activate") },
    async ({ brandId }) => {
      setActiveBrandId(brandId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Active brand set to: ${brandId}`,
          },
        ],
      };
    }
  );

  // ── Get brand info ────────────────────────────────────────────────────────
  server.tool(
    "get_brand_info",
    "Get a brand's profile. Returns core identity fields plus slim summaries: themes as [{id,title}], voiceProfiles as [{id,name,isActive,optimizedMedium}], blogAuthors as [{id,firstName,lastName}], and postCount/memberCount as numbers. Use list_themes, list_voices, list_blog_authors, list_posts, or get_brand_members for full detail on each.",
    {
      detail: detailParam("full"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}`);
      const { audienceData, operationStatus, blogArticles, ...slim } = data ?? {};
      const result = detail === "short"
        ? { id: data?.id, name: data?.name, ...(data?.websiteUrl ? { websiteUrl: data?.websiteUrl } : {}) }
        : detail === "medium"
        ? slim
        : data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Create brand (interactive step 1 — manual path) ──────────────────────
  server.tool(
    "create_brand",
    [
      "STEP 1 of brand onboarding (manual path — no website crawl).",
      "Creates a new brand from user-supplied name/description, sets it as active,",
      "then RETURNS a `nextStep` payload telling you to ask the user which platforms",
      "they publish on. After the user answers, call `set_brand_mediums` with their picks.",
      "Ask the user for a description if they did not provide one — onboarding will fail without it.",
    ].join(" "),
    {
      name: z.string().describe("Brand name"),
      tone: z.string().optional().describe("Writing tone, e.g. 'Bold & Direct'"),
      audience: z.string().optional().describe("Target audience description"),
      website: z.string().url().optional().describe("Website URL"),
      description: z.string().optional().describe("Brand description (required if no website)"),
    },
    async (args) => {
      const data = await api.post<{ brand?: { id?: string }; id?: string }>("/api/agent/v1/brands", args);
      const brandId = data.brand?.id ?? data.id;
      if (brandId) setActiveBrandId(brandId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                brandId,
                brand: data,
                nextStep: {
                  action: "set_brand_mediums",
                  ask: "Which social platforms does this brand publish on? Pick one or more from: x, linkedin, instagram, threads, facebook, tiktok, youtube, pinterest, bluesky.",
                  then: "Call `set_brand_mediums` with the user's picks. After that, call `get_onboarding_status` and keep polling (every 15s) until `done` — that surfaces the AI-generated audience review + themes.",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Onboard brand from website (interactive step 1 — URL path) ───────────
  server.tool(
    "onboard_brand",
    [
      "STEP 1 of brand onboarding (website path).",
      "Crawls the site in the background and kicks off audience analysis + 10 themes.",
      "Sets the new brand as active and RETURNS a `nextStep` payload.",
      "IMMEDIATELY after this returns, ask the user which social platforms they publish on,",
      "then call `set_brand_mediums`. Do not call `get_onboarding_status` until mediums are set.",
    ].join(" "),
    {
      websiteUrl: z.string().url().describe("The website to crawl and analyze"),
      name: z.string().optional().describe("Brand name (inferred from site if omitted)"),
    },
    async ({ websiteUrl, name }) => {
      const data = await api.post<{ brandId?: string }>("/api/agent/v1/brands/onboard", {
        websiteUrl,
        name,
      });
      if (data.brandId) setActiveBrandId(data.brandId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...data,
                nextStep: {
                  action: "set_brand_mediums",
                  ask: "While I crawl the site, which platforms do you publish on? Pick from: x, linkedin, instagram, threads, facebook, tiktok, youtube, pinterest, bluesky.",
                  then: "Call `set_brand_mediums` with the picks. Then call `get_onboarding_status` and poll (every 15s) until status=`done` — that surfaces the generated audience + themes.",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Set brand mediums (interactive step 2) ───────────────────────────────
  server.tool(
    "set_brand_mediums",
    [
      "STEP 2 of brand onboarding. Saves the list of platforms the brand publishes on.",
      "Call this immediately after `create_brand` or `onboard_brand` and the user has picked platforms.",
      "After this, call `get_onboarding_status` every ~15 seconds until it reports `done`.",
    ].join(" "),
    {
      mediums: z
        .array(
          z.enum([
            "x",
            "linkedin",
            "instagram",
            "threads",
            "facebook",
            "tiktok",
            "youtube",
            "pinterest",
            "bluesky",
          ])
        )
        .min(1)
        .describe("Platforms the brand publishes on"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ mediums, brandId }) => {
      const id = requireBrandId(brandId);
      await api.patch(`/api/agent/v1/brands/${id}`, {
        brandSettings: { selectedMediums: mediums },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                brandId: id,
                selectedMediums: mediums,
                nextStep: {
                  action: "get_onboarding_status",
                  then: "Poll every ~15s. When status=`done`, summarize the generated audience/themes to the user. You can also offer to connect social accounts (check_social_accounts → generate_connect_link) or generate the first post.",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Get brand mediums (read) ──────────────────────────────────────────────
  server.tool(
    "get_brand_mediums",
    [
      "Read which publishing platforms (mediums) a brand posts to.",
      "Read-only counterpart to set_brand_mediums.",
      "NOTE: Reddit is NOT a medium — Reddit is a separate repurpose module; use the reddit_* tools or dashboard_link section 'reddit'.",
    ].join(" "),
    {
      brandId: z.string().optional().describe("Brand ID (defaults to active brand)"),
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}`);
      const brandSettings = data?.brandSettings != null && typeof data.brandSettings === "object"
        ? (data.brandSettings as Record<string, unknown>)
        : null;
      const selectedMediums = Array.isArray(brandSettings?.selectedMediums)
        ? (brandSettings.selectedMediums as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ brandId: id, selectedMediums }) }],
      };
    }
  );

  // ── Get brand members ─────────────────────────────────────────────────────
  server.tool(
    "get_brand_members",
    "List all active members of a brand with their role and user info (id, name, email).",
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<{ members?: unknown[] }>(`/api/agent/v1/brands/${id}/members`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    }
  );

  // ── Onboarding status (interactive step 3 — poll) ────────────────────────
  server.tool(
    "get_onboarding_status",
    "STEP 3 of brand onboarding. Polls background analysis + theme generation. detail='short' returns status only; detail='medium' (default) adds audienceSummary+themeCount; detail='full' returns raw data. Poll every ~15s. When done, surface the audience review + themes to the user.",
    {
      detail: detailParam("medium"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/status`);
      let result: unknown;
      if (detail === "short") {
        result = { status: data?.status };
      } else if (detail === "medium") {
        result = {
          status: data?.status,
          audienceSummary: truncate(data?.audienceReview, 300),
          themeCount: Array.isArray(data?.themes) ? data.themes.length : null,
        };
      } else {
        result = data;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── List themes ───────────────────────────────────────────────────────────
  server.tool(
    "list_themes",
    "List all content themes for the active brand with their IDs. detail='short' (default) returns id+title; detail='medium' adds content preview; detail='full' returns raw content.",
    {
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown[]>(`/api/agent/v1/brands/${id}/themes`);
      const rawThemes = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
      const proj: Projector<Record<string, unknown>> = {
        short: (t) => ({ id: t.id, title: t.title }),
        medium: (t) => slimTheme(t),
      };
      const result = { count: rawThemes.length, detail, themes: projectList(detail, rawThemes, proj) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Edit theme ────────────────────────────────────────────────────────────
  server.tool(
    "edit_theme",
    "Edit an existing content theme's title or content instructions.",
    {
      themeId: z.string().describe("Theme ID to edit"),
      title: z.string().optional().describe("New title for the theme"),
      content: z.string().optional().describe("New content instructions for the theme"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ themeId, title, content, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch(`/api/agent/v1/brands/${id}/themes/${themeId}`, { title, content });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Delete theme ──────────────────────────────────────────────────────────
  server.tool(
    "delete_theme",
    "Delete a content theme from the active brand.",
    {
      themeId: z.string().describe("Theme ID to delete"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ themeId, brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/themes/${themeId}`);
      return {
        content: [{ type: "text" as const, text: `Theme ${themeId} deleted.` }],
      };
    }
  );

  // ── Generate themes ───────────────────────────────────────────────────────
  server.tool(
    "generate_themes",
    "Generate new content themes using AI. Waits a short grace window for generation to finish; if it's still running server-side after that, returns a 'generating' status instead of blocking — call list_themes a few seconds later to retrieve the new themes. Deducts credits.",
    {
      count: z.number().min(1).max(20).optional().default(5).describe("Number of themes to generate"),
      instructions: z.string().optional().describe("Custom instructions, e.g. 'Focus on startup growth'"),
      input: z.string().optional().describe("Source text or file path to derive themes from"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ count, instructions, input, brandId }) => {
      const id = requireBrandId(brandId);

      await api.post(`/api/agent/v1/brands/${id}/themes/generate`, {
        count,
        instructions,
        input,
      });

      // Poll brand until theme generation is complete, or the grace window elapses.
      const done = await pollUntilDone(`/api/agent/v1/brands/${id}`);
      if (done === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "generating",
                note: "Theme generation is still running server-side. Call list_themes in a few seconds to retrieve the new themes once ready.",
              }),
            },
          ],
        };
      }

      // Fetch the freshly generated themes
      const themes = await api.get<unknown[]>(`/api/agent/v1/brands/${id}/themes`);
      const slim = Array.isArray(themes) ? themes.map(slimTheme) : themes;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );

  // ── Get social media rules ────────────────────────────────────────────────
  server.tool(
    "get_social_media_rules",
    "Read a brand's per-platform social media content rules (the same rules editable in dashboard Settings → Social media rules). Covers content/structure/engagement/visual-strategy guidance plus secrets, guidelines, content types, things to avoid, and core principles. Call this BEFORE set_social_media_rules so you only change the fields you intend to.",
    {
      platform: z
        .enum(["linkedin", "x/twitter", "facebook", "instagram", "threads", "general"])
        .optional()
        .describe("Filter to a single platform. Omit to return all 6 platforms."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platform, brandId }) => {
      const id = requireBrandId(brandId);
      const url = `/api/agent/v1/brands/${id}/social-media-rules${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`;
      const data = await api.get<unknown>(url);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    }
  );

  // ── Set social media rules ────────────────────────────────────────────────
  server.tool(
    "set_social_media_rules",
    "Update a brand's social media content rules for ONE platform. By default this MERGES your provided fields into the existing rules (send only what you want to change — other fields are preserved; arrays you provide replace the old array). Set replace=true to overwrite the entire platform ruleset. Valid platforms: linkedin, x/twitter, facebook, instagram, threads, general. Tip: call get_social_media_rules first to see current values.",
    {
      platform: z
        .enum(["linkedin", "x/twitter", "facebook", "instagram", "threads", "general"])
        .describe("The platform whose rules you want to update."),
      rules: z
        .object({
          content: z
            .object({
              postLength: z.string().optional(),
              captionLength: z.string().optional(),
              paragraphs: z.string().optional(),
              readingLevel: z.string().optional(),
              emojis: z.string().optional(),
              hashtags: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe("Controls post length, caption length, paragraph style, reading level, emoji usage, and hashtag strategy."),
          structure: z
            .object({
              hook: z.string().optional(),
              ending: z.string().optional(),
              links: z.string().optional(),
              careerAngle: z.string().optional(),
              sentences: z.string().optional(),
              storytelling: z.string().optional(),
              personalization: z.string().optional(),
              formatting: z.string().optional(),
              threads: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe("Controls hook style, ending/CTA, links, sentence structure, storytelling, formatting, and thread layout."),
          engagement: z
            .object({
              questions: z.string().optional(),
              reactions: z.string().optional(),
              shareability: z.string().optional(),
              community: z.string().optional(),
              authenticity: z.string().optional(),
              firstComment: z.string().optional(),
              savability: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe("Controls how the post drives comments, shares, saves, authenticity signals, and community interaction."),
          visualStrategy: z
            .object({
              consistency: z.string().optional(),
              firstFrame: z.string().optional(),
              textOnImage: z.string().optional(),
              branding: z.string().optional(),
              quality: z.string().optional(),
            })
            .passthrough()
            .optional()
            .describe("Controls visual brand consistency, first-frame hooks, text-on-image usage, branding elements, and quality standards."),
          secrets: z.array(z.string()).optional().describe("Hidden power tactics or platform-specific tricks."),
          guidelines: z.array(z.string()).optional().describe("General writing and posting guidelines for this platform."),
          contentTypes: z.array(z.string()).optional().describe("Types of content that perform well on this platform."),
          avoid: z.array(z.string()).optional().describe("Things to avoid when posting on this platform."),
          principles: z.array(z.string()).optional().describe("Core content principles for this platform."),
        })
        .describe("Partial or full ruleset to apply. Only provide the fields you want to change when merging."),
      replace: z
        .boolean()
        .optional()
        .describe("Overwrite the entire platform ruleset instead of merging."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ platform, rules, replace, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { platform, rules };
      if (replace !== undefined) body.replace = replace;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/social-media-rules`, body);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    }
  );
}
