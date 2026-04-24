/**
 * Landing pages + side pages tools.
 *
 * All tools wrap /api/agent/v1/landing-pages/* and /api/agent/v1/brands/{id}/landing-pages
 * as mapped in docs/43-agentic/08-update-mcp/00-reqs.md §3.1.
 *
 * Async ops (generate, vibe-edit, side-page generate) return { operationId }
 * — use get_job to poll them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

export function registerLpTools(server: McpServer) {
  // ── List landing pages ────────────────────────────────────────────────────
  server.tool(
    "list_landing_pages",
    "List all landing pages for the active brand. Returns slug, status, and title.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(
        `/api/agent/v1/brands/${id}/landing-pages`
      );
      const pages = data?.landingPages ?? data?.pages ?? (Array.isArray(data) ? data : []);
      return { content: [{ type: "text" as const, text: JSON.stringify(pages, null, 2) }] };
    }
  );

  // ── Generate landing page (async) ─────────────────────────────────────────
  server.tool(
    "generate_landing_page",
    [
      "Generate a new AI landing page for the brand. This is an async operation — it returns immediately with a slug.",
      "Poll with get_job(operationId) or view_landing_page(slug) to see when content is ready.",
    ].join(" "),
    {
      topic: z.string().describe("Topic or product this landing page should be about"),
      slug: z.string().optional().describe("Desired URL slug (auto-generated if omitted)"),
      voiceProfileId: z.string().optional().describe("Voice profile ID for writing style"),
      brandId: brandOpt,
    },
    async ({ topic, slug, voiceProfileId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(
        `/api/agent/v1/brands/${id}/landing-pages`,
        { topic, slug, voiceProfileId }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── View landing page ─────────────────────────────────────────────────────
  server.tool(
    "view_landing_page",
    "Fetch the full content and metadata of a landing page by its slug.",
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.get<any>(`/api/agent/v1/landing-pages/${slug}`);
      const p = data?.landingPage ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }] };
    }
  );

  // ── Edit landing page (manual patch) ─────────────────────────────────────
  server.tool(
    "edit_landing_page",
    "Update the title or instructions of a landing page. For AI-powered edits, use vibe_edit_landing_page.",
    {
      slug: z.string().describe("Landing page slug"),
      title: z.string().optional().describe("New title"),
      instructions: z.string().optional().describe("Editor instructions stored for reference"),
    },
    async ({ slug, title, instructions }) => {
      const data = await api.patch<any>(`/api/agent/v1/landing-pages/${slug}`, {
        title,
        instructions,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set landing page content (manual write) ───────────────────────────────
  server.tool(
    "set_landing_page",
    [
      "Overwrite the content and/or metadata of a landing page.",
      "Pass content as a string (HTML or markdown). Pass metadata as a JSON object.",
      "Returns a versionId — all writes are versioned.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("Full page content (HTML or markdown)"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata object"),
    },
    async ({ slug, title, content, metadata }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (metadata !== undefined) body.metadata = metadata;
      const data = await api.put<any>(`/api/agent/v1/landing-pages/${slug}/content`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Regenerate landing page ───────────────────────────────────────────────
  server.tool(
    "regenerate_landing_page",
    [
      "Re-generate a landing page's content using AI. Optionally restrict to specific sections.",
      "Returns an operationId — poll with get_job to track progress.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      voiceProfileId: z.string().optional().describe("Voice profile ID"),
      instructions: z.string().optional().describe("Extra guidance for the AI"),
      sections: z
        .array(z.string())
        .optional()
        .describe("Specific section keys to regenerate (omit to regenerate all)"),
    },
    async ({ slug, voiceProfileId, instructions, sections }) => {
      const body: Record<string, unknown> = {};
      if (voiceProfileId) body.voiceProfileId = voiceProfileId;
      if (instructions) body.instructions = instructions;
      if (sections?.length) body.sections = sections;
      const data = await api.post<any>(`/api/agent/v1/landing-pages/${slug}/generate`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Vibe edit (AI edit) ───────────────────────────────────────────────────
  server.tool(
    "vibe_edit_landing_page",
    [
      "Use AI to edit a landing page based on natural-language instructions.",
      "Returns an operationId — poll with get_vibe_edit_status or get_job until status is 'completed'.",
      "Optionally limit to a specific scope ('headline' | 'cta' | 'full') or a single sectionId.",
    ].join(" "),
    {
      slug: z.string().describe("Landing page slug"),
      instructions: z
        .string()
        .describe("Natural-language edit instructions, e.g. 'Make the CTA more urgent'"),
      scope: z
        .enum(["headline", "cta", "full"])
        .optional()
        .describe("Restrict edits to a specific section type"),
      sectionId: z.string().optional().describe("Specific section ID to edit"),
    },
    async ({ slug, instructions, scope, sectionId }) => {
      const body: Record<string, unknown> = { instructions };
      if (scope) body.scope = scope;
      if (sectionId) body.sectionId = sectionId;
      const data = await api.post<any>(`/api/agent/v1/landing-pages/${slug}/ai-edit`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Get vibe edit status ──────────────────────────────────────────────────
  server.tool(
    "get_vibe_edit_status",
    "Poll the status of a vibe (AI) edit operation. Use the operationId from vibe_edit_landing_page.",
    {
      slug: z.string().describe("Landing page slug"),
      operationId: z.string().describe("Operation ID from vibe_edit_landing_page"),
    },
    async ({ slug, operationId }) => {
      const data = await api.get<any>(
        `/api/agent/v1/landing-pages/${slug}/ai-edit/status/${operationId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Publish landing page ──────────────────────────────────────────────────
  server.tool(
    "publish_landing_page",
    "Publish a landing page, making it publicly accessible at its URL.",
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.post<any>(`/api/agent/v1/landing-pages/${slug}/publish`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete landing page ───────────────────────────────────────────────────
  server.tool(
    "delete_landing_page",
    "Permanently delete a landing page. Pass confirm: true to proceed — this is irreversible.",
    {
      slug: z.string().describe("Landing page slug"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}`);
      return {
        content: [{ type: "text" as const, text: `Landing page "${slug}" deleted.` }],
      };
    }
  );

  // ── View draft ────────────────────────────────────────────────────────────
  server.tool(
    "view_lp_draft",
    "View the unpublished draft state of a landing page, including pending AI edits.",
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.get<any>(`/api/agent/v1/landing-pages/${slug}/draft`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── List versions ─────────────────────────────────────────────────────────
  server.tool(
    "list_lp_versions",
    "List all saved versions of a landing page. Each write or AI edit creates a new version.",
    {
      slug: z.string().describe("Landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.get<any>(`/api/agent/v1/landing-pages/${slug}/versions`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── View version ──────────────────────────────────────────────────────────
  server.tool(
    "view_lp_version",
    "View the content of a specific landing page version by numeric ID.",
    {
      slug: z.string().describe("Landing page slug"),
      versionId: z.number().int().describe("Numeric version ID from list_lp_versions"),
    },
    async ({ slug, versionId }) => {
      const data = await api.get<any>(
        `/api/agent/v1/landing-pages/${slug}/versions/${versionId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─────────────────── Side pages ────────────────────────────────────────────

  // ── List side pages ───────────────────────────────────────────────────────
  server.tool(
    "list_side_pages",
    "List all side pages (sub-pages) attached to a landing page.",
    {
      slug: z.string().describe("Parent landing page slug"),
    },
    async ({ slug }) => {
      const data = await api.get<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages`
      );
      const pages = data?.sidePages ?? (Array.isArray(data) ? data : []);
      return { content: [{ type: "text" as const, text: JSON.stringify(pages, null, 2) }] };
    }
  );

  // ── Generate side page (async) ────────────────────────────────────────────
  server.tool(
    "generate_side_page",
    [
      "Generate one or more AI side pages for a landing page.",
      "Returns an operationId — poll with get_side_page_status or get_job until complete.",
    ].join(" "),
    {
      slug: z.string().describe("Parent landing page slug"),
      type: z
        .string()
        .describe("Side-page type: 'faq' | 'pricing' | 'features' | 'about' | 'contact' | etc."),
      count: z.number().int().min(1).max(5).optional().default(1).describe("Number of side pages to generate"),
    },
    async ({ slug, type, count }) => {
      const data = await api.post<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages`,
        { type, count }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Get side page generation status ──────────────────────────────────────
  server.tool(
    "get_side_page_status",
    "Poll the status of a side-page generation operation. Use the operationId from generate_side_page.",
    {
      slug: z.string().describe("Parent landing page slug"),
      operationId: z.string().describe("Operation ID from generate_side_page"),
    },
    async ({ slug, operationId }) => {
      const data = await api.get<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/generate/status/${operationId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── View side page ────────────────────────────────────────────────────────
  server.tool(
    "view_side_page",
    "View the content and sections of a specific side page.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages)"),
    },
    async ({ slug, sideKey }) => {
      const data = await api.get<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`
      );
      const p = data?.sidePage ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }] };
    }
  );

  // ── Edit side page ────────────────────────────────────────────────────────
  server.tool(
    "edit_side_page",
    "Update the instructions or metadata of a side page. For section-level edits, use set_side_page_section.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      instructions: z.string().optional().describe("Updated instructions for the AI"),
    },
    async ({ slug, sideKey, instructions }) => {
      const data = await api.patch<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`,
        { instructions }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete side page ──────────────────────────────────────────────────────
  server.tool(
    "delete_side_page",
    "Delete a side page. Pass confirm: true to proceed.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug, sideKey }) => {
      await api.delete(`/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}`);
      return {
        content: [
          { type: "text" as const, text: `Side page "${sideKey}" deleted from "${slug}".` },
        ],
      };
    }
  );

  // ── Edit side page section ────────────────────────────────────────────────
  server.tool(
    "set_side_page_section",
    "Update the content of a specific section within a side page.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      sectionId: z.string().describe("Section ID from view_side_page"),
      content: z.string().optional().describe("New section content (HTML or markdown)"),
      instructions: z.string().optional().describe("AI-guided edit instructions for this section"),
    },
    async ({ slug, sideKey, sectionId, content, instructions }) => {
      const body: Record<string, unknown> = { sectionId };
      if (content !== undefined) body.content = content;
      if (instructions !== undefined) body.instructions = instructions;
      const data = await api.patch<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/section`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set side page state ───────────────────────────────────────────────────
  server.tool(
    "set_side_page_state",
    "Publish or unpublish a side page. Set published=true to make it live, false to pull it back to draft.",
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key"),
      published: z.boolean().describe("true = publish, false = unpublish"),
    },
    async ({ slug, sideKey, published }) => {
      const data = await api.post<any>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/state`,
        { published }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
