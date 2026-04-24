import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { pollUntilDone } from "../poll.js";
import { requireBrandId, setActiveBrandId, getActiveBrandId } from "../state.js";

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
    "List all brands on your PostKing account. Call this first to discover brandIds.",
    {},
    async () => {
      const data = await api.get<{ brands?: unknown[] }>("/api/agent/v1/brands");
      const raw = Array.isArray(data) ? data : (data.brands ?? [data]);
      const brands = raw.map(slimBrand);
      const active = getActiveBrandId();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ activeBrandId: active, brands }, null, 2),
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
    "Get the full profile of a brand — tone, audience, themes, social accounts, and more.",
    { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}`);
      const { audienceData, operationStatus, themes, blogArticles, ...slim } = data ?? {};
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
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

  // ── Onboarding status (interactive step 3 — poll) ────────────────────────
  server.tool(
    "get_onboarding_status",
    [
      "STEP 3 of brand onboarding. Polls the background analysis + theme generation.",
      "Returns one of: `pending`, `processing`, `done`, `failed`.",
      "Poll every ~15s. When `done`, onboarding is complete — surface the audience review + themes to the user.",
    ].join(" "),
    { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/status`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── List themes ───────────────────────────────────────────────────────────
  server.tool(
    "list_themes",
    "List all content themes for the active brand with their IDs.",
    { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown[]>(`/api/agent/v1/brands/${id}/themes`);
      const slim = Array.isArray(data) ? data.map(slimTheme) : data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
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
    "Generate new content themes using AI. Polls until complete. Deducts credits.",
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

      // Poll brand until theme generation is complete
      await pollUntilDone(`/api/agent/v1/brands/${id}`);

      // Fetch the freshly generated themes
      const themes = await api.get<unknown[]>(`/api/agent/v1/brands/${id}/themes`);
      const slim = Array.isArray(themes) ? themes.map(slimTheme) : themes;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );
}
