import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, truncate, type Projector } from "../detail.js";

/**
 * Trends + Content Templates tools.
 *
 * Canonical agent flow (`trends_to_post` guided prompt):
 *   1. Browse trending posts  → trends_list (account/niche-scoped, no brand required)
 *   2. Extract a template     → template_extract (AI deconstructs a trending post)
 *      OR pick best-fit       → template_pick (AI scores existing saved templates)
 *   3. Save if useful         → template_create (persist extracted template)
 *   4. Generate post          → create_post / existing post-generation tools
 *
 * Account-scoped tools (NO brandId): trends_list.
 * Brand-scoped tools: template_list, template_create, template_update,
 *   template_delete, template_extract, template_pick.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Projectors ────────────────────────────────────────────────────────────────

const templateProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
  }),
  medium: (r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    platforms: r.platforms,
    isFavorite: r.isFavorite,
    bodyPreview: truncate(r.body, 160),
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerTrendsTools(server: McpServer) {
  // ── trends_list ──────────────────────────────────────────────────────────────
  // ACCOUNT-SCOPED — no requireBrandId, no brandId param
  server.tool(
    "trends_list",
    [
      "Browse top-trending posts (with deconstructions) for a niche + platform.",
      "Account/niche-scoped — NOT tied to a specific brand.",
      "Each post includes hook, template, pattern, and virality reason from the deconstruction.",
      "The crawler runs every 3 days; use days=3 (default) for the freshest batch.",
      "Supported niches: ai-saas, marketing, web3. Supported platforms: x.",
    ].join(" "),
    {
      niche: z
        .string()
        .optional()
        .describe(
          "Niche to filter by. One of: ai-saas, marketing, web3. Defaults to ai-saas."
        ),
      platform: z
        .string()
        .optional()
        .describe("Platform to filter by. Currently only 'x' is supported. Defaults to x."),
      days: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe(
          "Look-back window in days (1–30). Defaults to 3 (the freshest crawler batch)."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of posts to return (1–50). Defaults to 20."),
      sort: z
        .enum(["engagement", "recent"])
        .optional()
        .describe(
          "Sort order: 'engagement' = highest engagement score first (default); 'recent' = newest crawled first."
        ),
    },
    async ({ niche, platform, days, limit, sort }) => {
      const qs = new URLSearchParams();
      if (niche) qs.set("niche", niche);
      if (platform) qs.set("platform", platform);
      if (days !== undefined) qs.set("days", String(days));
      if (limit !== undefined) qs.set("limit", String(limit));
      if (sort) qs.set("sort", sort);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/trends${suffix}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── template_list ────────────────────────────────────────────────────────────
  server.tool(
    "template_list",
    [
      "List the brand's saved content templates.",
      "short {id,title,category}; medium adds platforms,isFavorite,bodyPreview (160 chars); full = raw.",
      "Pass category to filter (e.g. 'hook', 'cta', 'thread').",
      "Results are ordered by isFavorite desc, then usageCount desc.",
    ].join(" "),
    {
      detail: detailParam("short"),
      category: z
        .string()
        .optional()
        .describe("Filter templates by category (e.g. 'hook', 'cta', 'thread'). Omit for all."),
      brandId: brandOpt,
    },
    async ({ detail, category, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (category) qs.set("category", category);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/content-templates${suffix}`
      );
      // The agent-v1 wrapper may return { templates: [...] } or a bare array.
      // Handle both defensively.
      let rows: Record<string, unknown>[];
      if (Array.isArray(data)) {
        rows = (data as unknown[]).filter(
          (r): r is Record<string, unknown> => !!r && typeof r === "object"
        );
      } else {
        const raw =
          data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        rows = Array.isArray(raw.templates)
          ? (raw.templates as unknown[]).filter(
              (r): r is Record<string, unknown> => !!r && typeof r === "object"
            )
          : [];
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: rows.length,
              detail,
              templates: projectList(detail, rows, templateProj),
            }),
          },
        ],
      };
    }
  );

  // ── template_create ──────────────────────────────────────────────────────────
  server.tool(
    "template_create",
    [
      "Create one or more content templates for the brand.",
      "Pass a single template object, or pass the 'templates' array param for bulk creation.",
      "If both are supplied, 'templates' (bulk) takes precedence.",
      "Returns the created template record(s).",
    ].join(" "),
    {
      title: z.string().min(1).optional().describe("Template title (required for single creation)."),
      body: z
        .string()
        .min(1)
        .optional()
        .describe("Template body with placeholders, e.g. '[HOOK] … [CTA]' (required for single creation)."),
      example: z
        .string()
        .nullable()
        .optional()
        .describe("An example post filled in using this template."),
      category: z
        .string()
        .nullable()
        .optional()
        .describe("Category label (e.g. 'hook', 'thread', 'cta')."),
      pattern: z
        .string()
        .nullable()
        .optional()
        .describe("The rhetorical or structural pattern described in plain language."),
      platforms: z
        .array(z.string())
        .optional()
        .describe("Platforms this template is best suited for (e.g. ['x', 'linkedin'])."),
      isFavorite: z
        .boolean()
        .optional()
        .describe("Mark as favorite to surface it first in template lists."),
      templates: z
        .array(
          z.object({
            title: z.string().min(1),
            body: z.string().min(1),
            example: z.string().nullable().optional(),
            category: z.string().nullable().optional(),
            pattern: z.string().nullable().optional(),
            platforms: z.array(z.string()).optional(),
            isFavorite: z.boolean().optional(),
          })
        )
        .optional()
        .describe("Bulk-create multiple templates in one call. Overrides the single-template fields when present."),
      brandId: brandOpt,
    },
    async ({ title, body, example, category, pattern, platforms, isFavorite, templates, brandId }) => {
      const id = requireBrandId(brandId);
      const payload = templates && templates.length > 0
        ? templates
        : { title, body, example, category, pattern, platforms, isFavorite };
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/content-templates`,
        payload
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── template_update ──────────────────────────────────────────────────────────
  server.tool(
    "template_update",
    [
      "Update an existing content template.",
      "All fields are optional — only supplied fields are changed.",
      "Use isFavorite=true/false to toggle favorite status.",
    ].join(" "),
    {
      templateId: z.string().describe("ID of the content template to update."),
      title: z.string().min(1).optional().describe("New title."),
      body: z.string().min(1).optional().describe("New template body."),
      example: z.string().nullable().optional().describe("New example post."),
      category: z.string().nullable().optional().describe("New category label."),
      pattern: z.string().nullable().optional().describe("New pattern description."),
      platforms: z.array(z.string()).optional().describe("Updated platform list."),
      isFavorite: z.boolean().optional().describe("Set true to favorite, false to un-favorite."),
      brandId: brandOpt,
    },
    async ({ templateId, title, body, example, category, pattern, platforms, isFavorite, brandId }) => {
      const id = requireBrandId(brandId);
      const payload: Record<string, unknown> = {};
      if (title !== undefined) payload.title = title;
      if (body !== undefined) payload.body = body;
      if (example !== undefined) payload.example = example;
      if (category !== undefined) payload.category = category;
      if (pattern !== undefined) payload.pattern = pattern;
      if (platforms !== undefined) payload.platforms = platforms;
      if (isFavorite !== undefined) payload.isFavorite = isFavorite;
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/content-templates/${templateId}`,
        payload
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── template_delete ──────────────────────────────────────────────────────────
  server.tool(
    "template_delete",
    [
      "Permanently delete a content template from the brand.",
      "This action is irreversible.",
    ].join(" "),
    {
      templateId: z.string().describe("ID of the content template to delete."),
      brandId: brandOpt,
    },
    async ({ templateId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(
        `/api/agent/v1/brands/${id}/content-templates/${templateId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── template_extract ─────────────────────────────────────────────────────────
  server.tool(
    "template_extract",
    [
      "AI extracts a reusable content template from a pasted post text.",
      "Synchronous (seconds) — no polling needed.",
      "Pass save=true to also persist the template to the brand's library.",
      "Returns the extracted template object; if saved, includes the new template id.",
    ].join(" "),
    {
      postText: z
        .string()
        .min(10)
        .describe("The full text of the post to deconstruct into a reusable template (min 10 chars)."),
      save: z
        .boolean()
        .optional()
        .describe("When true, the extracted template is saved to the brand's template library."),
      brandId: brandOpt,
    },
    async ({ postText, save, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { postText };
      if (save !== undefined) body.save = save;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/content-templates/extract`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── template_pick ────────────────────────────────────────────────────────────
  server.tool(
    "template_pick",
    [
      "RE-RANKER: AI scores a caller-supplied list of candidate templates and picks the N best-fitting ones for a given theme or topic.",
      "This tool does NOT read stored templates server-side — the caller must supply the candidates explicitly (e.g. call template_list first, then pass the results here).",
      "Synchronous — no polling needed.",
      "Pass the templates array from template_list (full detail) as candidates.",
      "Returns { templateIds } — an ordered array of the winning template IDs.",
    ].join(" "),
    {
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .describe("How many templates to pick (1–20)."),
      theme: z
        .string()
        .min(1)
        .describe("The topic or theme the agent should optimise for (e.g. 'AI productivity tips')."),
      templates: z
        .array(
          z.object({
            id: z.string().describe("Template ID."),
            title: z.string().describe("Template title."),
            body: z.string().describe("Template body."),
            category: z.string().nullable().describe("Template category (null if unset)."),
          })
        )
        .min(1)
        .describe(
          "Candidate templates to evaluate. Use template_list with detail='full' and pass the relevant fields."
        ),
      brandId: brandOpt,
    },
    async ({ count, theme, templates, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/content-templates/pick`,
        { count, theme, templates }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
