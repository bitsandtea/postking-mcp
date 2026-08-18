import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../../client.js";
import { requireBrandId } from "../../state.js";
import { etaFor } from "../../etas.js";
import { config } from "../../config.js";
import { derivedJobFields } from "../jobs.js";

/**
 * SEO / GEO flow — side-page generation linked to a cluster/brief, and
 * standalone comparison-page creation (no cluster/brief flow required).
 *
 * See src/tools/seo/index.ts for the full flow doc comment.
 */

export function registerSeoSidePageTools(server: McpServer) {
  // ── 13. Generate a side page linked to an SEO cluster ─────────────────────
  server.tool(
    "seo_generate_side_page",
    [
      "Generates a side page for a brand's landing page, optionally linked to an SEO cluster (`clusterId`).",
      "When linked, the side page surfaces in cluster-context queries and inherits the cluster's keyword targeting — strengthening topical authority that feeds GEO citation patterns.",
      "Two body modes:",
      "  • freeform: pass `key` + `prompt` (+ optional `keywords`, `selectedSections`, `voiceProfileId`, `sidePageType`). Freeform now writes real section-level content (hero/features/showcase/faq/cta), not just metadata.",
      "  • brief: pass `key` + `brief` (structured outline) + optional `briefId` and `roadmapItemId`.",
      `Typically takes ${etaFor("landing_page_side_pages_generate")}.`,
      "Async — returns `{ success, operationId, operationRowId, pollUrl, sidePageId }`. Poll `get_job` with the returned `operationId` until `state` is `completed` (or `failed`/`partially_failed`/`cancelled` on error); the generated page's sections will be populated once complete. Comparison-type briefs run synchronously and return `sidePageId` directly.",
      "`slug` is the PARENT landing page slug under which the side page is created.",
    ].join(" "),
    {
      slug: z.string().min(1).describe("Parent landing page slug"),
      key: z.string().min(1).describe("Side-page key (URL slug fragment under the parent LP)"),
      prompt: z
        .string()
        .optional()
        .describe("Freeform-mode generation prompt (omit when passing `brief`)"),
      brief: z
        .unknown()
        .optional()
        .describe("Brief-mode structured outline. When set, this is the canonical payload."),
      keywords: z
        .array(z.string())
        .optional()
        .describe("Freeform-mode: target keywords to weave into the page"),
      selectedSections: z
        .array(z.string())
        .optional()
        .describe("Freeform-mode: restrict generation to these section ids (e.g. hero, features, showcase, faq, cta, pricing). Omit to generate all default sections."),
      sidePageType: z
        .enum(["landing", "text", "comparison", "custom"])
        .optional()
        .describe(
          "Defaults to 'landing'. Use 'comparison' only with a persisted comparison briefId. Use 'custom' for the block-model page type (an ordered blocks[] array — see list_block_types/add_block/edit_block/delete_block/reorder_blocks) when the page needs a shape the fixed section list can't express."
        ),
      voiceProfileId: z.string().optional().describe("Voice profile to write in"),
      autoAssignAssets: z
        .boolean()
        .optional()
        .describe("Auto-assign brand assets to image slots after generation"),
      clusterId: z
        .string()
        .optional()
        .describe("SEO KeywordCluster ID to link this side page to (maps to SidePage.sourceClusterId)"),
      briefId: z
        .string()
        .optional()
        .describe("Persisted SeoBrief ID — required for comparison-type generation"),
      roadmapItemId: z.string().optional().describe("Roadmap item ID this side page is fulfilling"),
    },
    async ({ slug, key, prompt, brief, keywords, selectedSections, sidePageType, voiceProfileId, autoAssignAssets, clusterId, briefId, roadmapItemId }) => {
      const body: Record<string, unknown> = { key };
      if (prompt !== undefined) body.prompt = prompt;
      if (brief !== undefined) body.brief = brief;
      if (keywords !== undefined) body.keywords = keywords;
      if (selectedSections !== undefined) body.selectedSections = selectedSections;
      if (sidePageType !== undefined) body.sidePageType = sidePageType;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;
      if (autoAssignAssets !== undefined) body.autoAssignAssets = autoAssignAssets;
      if (clusterId !== undefined) body.clusterId = clusterId;
      if (briefId !== undefined) body.briefId = briefId;
      if (roadmapItemId !== undefined) body.roadmapItemId = roadmapItemId;
      const data = await api.post<unknown>(
        `/api/agent/v1/landing-pages/${slug}/side-pages/generate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Create a manual comparison page (no cluster / brief flow required) ─────
  server.tool(
    "create_comparison_page",
    [
      "Create a comparison / 'X vs Y' / 'best <category>' page for the brand WITHOUT going through the full SEO cluster → brief flow. One call kicks off generation and returns quickly with an operationId and a 'still_generating' or 'completed' status — it does NOT block until the page is fully built.",
      "`mode` controls the engine: 'research' crawls the named competitors + live SERP results before writing — slower (can take several minutes) but produces the strongest, best-grounded page; 'simple' skips all crawling and lets the LLM author from what you provide — fast, best when you already have the facts or just want a quick draft.",
      "When your inputs are sparse (few/no options, no domains, no seedData), prefer 'research' — it will discover and ground the comparison for you and yield a far stronger page than 'simple'.",
      "`seedData` (simple mode): paste your own raw facts/notes/competitor details here and the LLM writes from them instead of crawling — this is how you feed your own data and avoid a crawl.",
      "Async — fires the create, then waits only a short grace window before responding. On success returns { briefId, sidePageId, sidePageSlug, landingPageSlug, webUrl, warnings }. If it is still running past the grace window, returns { status: 'still_generating', operationId } — poll get_job with that operationId until state is 'completed'; do NOT fabricate the page yourself, and do NOT call create_comparison_page again for the same request while it's pending.",
      "Any `warnings` are surfaced verbatim — relay them to the user (e.g. sparse-input notes such as 'research mode would produce a stronger page').",
    ].join(" "),
    {
      mode: z
        .enum(["research", "simple"])
        .describe(
          "Generation engine. 'research' = crawl the competitors + live SERP, then write (slower, strongest, best for sparse inputs). 'simple' = no crawl, LLM authors from what you pass (fast; pair with seedData to feed your own facts)."
        ),
      primaryKeyword: z
        .string()
        .min(1)
        .describe(
          "The topic/keyword the page targets, e.g. \"Acme vs alternatives\", \"best CRM for startups\", \"Notion vs Obsidian\"."
        ),
      options: z
        .array(
          z.object({
            name: z.string().min(1).describe("Option / product / brand name"),
            domain: z.string().optional().describe("Option's website domain (helps research mode crawl it)"),
            isBrandOwn: z.boolean().optional().describe("True if this option is the user's own brand"),
          })
        )
        .optional()
        .describe("The things being compared. Omit to let research mode discover them."),
      pinnedCompetitor: z
        .object({
          name: z.string().min(1).describe("Competitor name"),
          domain: z.string().optional().describe("Competitor domain"),
        })
        .optional()
        .describe("A specific competitor to anchor a head-to-head comparison around."),
      preset: z
        .enum(["head_to_head", "alternatives_listicle", "category_roundup"])
        .optional()
        .describe("Page shape: head_to_head (X vs Y), alternatives_listicle (X vs alternatives), or category_roundup (best <category>). Inferred when omitted."),
      allowGenericRoundup: z
        .boolean()
        .optional()
        .describe("Allow a generic category roundup when no concrete options are supplied."),
      seedData: z
        .string()
        .optional()
        .describe("Simple-mode only: your own raw data/notes/facts about the options. When set, the LLM writes from this instead of crawling — feed it here to avoid a research crawl."),
      briefData: z
        .unknown()
        .optional()
        .describe("Advanced: a full pre-built structured comparison brief. When supplied, generation uses it directly and skips the LLM authoring step."),
      parentLandingPageSlug: z
        .string()
        .optional()
        .describe("Slug of the parent landing page to nest this comparison under. Defaults to the brand's primary landing page."),
      proposedSlug: z
        .string()
        .optional()
        .describe("Desired URL slug fragment for the new page (auto-generated from primaryKeyword if omitted)."),
      voiceProfileId: z.string().optional().describe("Voice profile ID to write the page in."),
      brandId: z.string().optional().describe("Brand ID (defaults to active brand)"),
    },
    async ({ mode, primaryKeyword, options, pinnedCompetitor, preset, allowGenericRoundup, seedData, briefData, parentLandingPageSlug, proposedSlug, voiceProfileId, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { mode, primaryKeyword };
      if (options !== undefined) body.options = options;
      if (pinnedCompetitor !== undefined) body.pinnedCompetitor = pinnedCompetitor;
      if (preset !== undefined) body.preset = preset;
      if (allowGenericRoundup !== undefined) body.allowGenericRoundup = allowGenericRoundup;
      if (seedData !== undefined) body.seedData = seedData;
      if (briefData !== undefined) body.briefData = briefData;
      if (parentLandingPageSlug !== undefined) body.parentLandingPageSlug = parentLandingPageSlug;
      if (proposedSlug !== undefined) body.proposedSlug = proposedSlug;
      if (voiceProfileId !== undefined) body.voiceProfileId = voiceProfileId;

      const created = await api.post<{ operationId: string; status?: string; webUrl?: string }>(
        `/api/agent/v1/brands/${id}/comparison-pages`,
        body
      );
      const operationId = created.operationId;
      const webUrl = created.webUrl;

      // Comparison pages (especially research mode) can take minutes, so we
      // only wait up to generateGracePollMs (mirrors generate_post) before handing
      // the agent a "still running, keep polling" instruction instead of holding
      // the MCP request open — the remote gateway kills longer-blocking calls.
      // Terminal-state detection reuses derivedJobFields (the same helper
      // get_job uses against the operations endpoint).
      const maxAttempts = Math.ceil(config.generateGracePollMs / config.pollIntervalMs);
      let op: Record<string, unknown> = {};
      let timedOut = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
        op = await api.get<Record<string, unknown>>(
          `/api/agent/v1/brands/${id}/operations/${operationId}`
        );
        const { done, summary } = derivedJobFields(op);
        if (done) {
          if (String(op.state) !== "completed") {
            throw new Error(`Comparison page generation ${summary}`);
          }
          break;
        }
        if (attempt === maxAttempts - 1) timedOut = true;
      }

      if (timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "still_generating",
                operationId,
                ...(webUrl ? { webUrl } : {}),
                instruction:
                  "Generation is STILL RUNNING — it has NOT failed. Do NOT write or invent the comparison page yourself. Wait ~15s, then call get_job with this operationId (wait:true). Repeat until state is 'completed', then read the page details from the operation's result.",
              }),
            },
          ],
        };
      }

      const result = (op.result && typeof op.result === "object" ? op.result : {}) as Record<string, unknown>;
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
      const out: Record<string, unknown> = {
        status: "completed",
        briefId: result.briefId,
        sidePageId: result.sidePageId,
        sidePageSlug: result.sidePageSlug,
        landingPageSlug: result.landingPageSlug,
        ...(webUrl ? { webUrl } : {}),
        warnings,
      };
      if (warnings.length > 0) {
        out.note = `Generation completed with ${warnings.length} warning(s) — relay these to the user: ${warnings.join(" | ")}`;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out) }],
      };
    }
  );
}
