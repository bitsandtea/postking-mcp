import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, truncate, type Projector } from "../detail.js";
import { etaFor } from "../etas.js";

/**
 * Audience / ICP tools.
 *
 * The brand's audience intelligence (ideal-customer-profile) is mined from the
 * brand's website + onboarding and reused to ground generation. The GET endpoint
 * returns the structured ICP (`audienceData`), the `positioning` (`blogContext`),
 * the ghostwriter `persona`, and `contentModulation`.
 *
 * Canonical agent flow:
 *   1. Inspect → get_audience (read the current ICP / persona)
 *   2. Plan    → preview_audience_edit (discover which `sections`/`subsections`
 *                are valid for this brand before editing)
 *   3. Edit    → edit_audience (async LLM ai-edit; returns { operationId } —
 *                poll get_job until state=completed)
 *
 * Read-only tools: get_audience, preview_audience_edit.
 * Write tools:     edit_audience.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Response shape ─────────────────────────────────────────────────────────────

interface AudienceResponse {
  brandId?: string;
  name?: string;
  websiteUrl?: string;
  lastAnalyzed?: string;
  /** Structured ICP block: demographics, primaryRoles, painPoints, etc. */
  audienceData?: unknown;
  /** = positioning */
  blogContext?: unknown;
  /** Ghostwriter persona { role, styleNotes, ... } — may be null. */
  persona?: unknown;
  contentModulation?: unknown;
  [k: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** First `n` entries of an array; pass non-arrays through unchanged (null when absent). */
function topList(v: unknown, n: number): unknown {
  if (Array.isArray(v)) return v.slice(0, n);
  return v ?? null;
}

/** Compact persona view — surfaces persona.role (+ styleNotes summary when full). */
function personaRef(p: unknown, withNotes = false): unknown {
  const o = asObj(p);
  if (!o) return null;
  return withNotes ? { role: o.role ?? null, styleNotes: truncate(o.styleNotes, 200) } : { role: o.role ?? null };
}

/** Positioning (blogContext) — truncate prose, pass small objects through. */
function positioning(v: unknown): unknown {
  if (typeof v === "string") return truncate(v, 600);
  return v ?? null;
}

// ── Projector ─────────────────────────────────────────────────────────────────

const audienceProj: Projector<AudienceResponse> = {
  // Compact ICP summary: name + primaryRoles + top painPoints + persona.role.
  short: (r) => {
    const ad = asObj(r.audienceData);
    return {
      brandId: r.brandId,
      name: r.name,
      primaryRoles: ad?.primaryRoles ?? null,
      painPoints: topList(ad?.painPoints, 5),
      persona: personaRef(r.persona),
      lastAnalyzed: r.lastAnalyzed,
    };
  },
  // Adds positioning + fuller demographics.
  medium: (r) => {
    const ad = asObj(r.audienceData);
    return {
      brandId: r.brandId,
      name: r.name,
      websiteUrl: r.websiteUrl,
      lastAnalyzed: r.lastAnalyzed,
      primaryRoles: ad?.primaryRoles ?? null,
      demographics: ad?.demographics ?? null,
      painPoints: ad?.painPoints ?? null,
      positioning: positioning(r.blogContext),
      persona: personaRef(r.persona, true),
    };
  },
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerAudienceTools(server: McpServer) {
  // ── get_audience ─────────────────────────────────────────────────────────────
  server.tool(
    "get_audience",
    [
      "Fetch the brand's audience intelligence / ICP (ideal customer profile).",
      "short = compact summary (name + primaryRoles + top painPoints + persona.role);",
      "medium adds positioning + fuller demographics; full = the raw payload (audienceData + positioning + persona + contentModulation).",
      "`persona` is the ghostwriter persona ({ role, styleNotes, ... }) and may be null.",
      "If the brand has no audience data yet, run website/audience analysis (onboarding) first.",
    ].join(" "),
    {
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      try {
        const data = await api.get<AudienceResponse>(`/api/agent/v1/brands/${id}/audience`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(project(detail, data, audienceProj)) }],
        };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.code === "NOT_FOUND")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "no_audience_data",
                  message:
                    "This brand has no audience/ICP data yet. Run the brand's website/audience analysis (onboarding) first, then call get_audience again.",
                }),
              },
            ],
          };
        }
        throw err;
      }
    }
  );

  // ── preview_audience_edit ──────────────────────────────────────────────────────
  server.tool(
    "preview_audience_edit",
    [
      "Read-only helper. Call this BEFORE edit_audience to discover which `sections`/`subsections` values are valid for this brand.",
      "Pass the natural-language change you intend to make; returns the available sections/subsections (computed from the brand's current audience data) plus a preview.",
      "Use the returned section keys (e.g. 'demographics', 'painPoints', 'positioning') as the required `sections` array for edit_audience.",
    ].join(" "),
    {
      prompt: z.string().min(1).describe("Natural-language description of the change you want to make to the audience/ICP."),
      brandId: brandOpt,
    },
    async ({ prompt, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/audience-review/ai-edit/preprompt`, { prompt });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── edit_audience ──────────────────────────────────────────────────────────────
  server.tool(
    "edit_audience",
    (() => {
      const eta = etaFor("brand_audience_review_edit");
      return [
        "Async LLM ai-edit of the brand's audience/ICP. Describe the change in `prompt` (natural language).",
        "`sections` is REQUIRED — the audience section(s) to edit (e.g. 'demographics', 'painPoints', 'positioning').",
        "If unsure which sections are valid for this brand, call preview_audience_edit first and use the section keys it returns.",
        "Returns { operationId, status } — poll get_job(operationId) until state is 'completed' (or 'failed'/'cancelled' on error).",
        "Only one audience edit can run at a time; a second call returns an 'already_running' notice.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      prompt: z.string().min(1).describe("Natural-language instruction describing the change to make to the audience/ICP."),
      sections: z
        .array(z.string())
        .min(1)
        .describe(
          "REQUIRED. Audience section keys to edit (e.g. ['demographics'], ['painPoints'], ['positioning']). Call preview_audience_edit to discover valid values for this brand."
        ),
      subsections: z
        .record(z.array(z.string()))
        .optional()
        .describe("Optional map of section → subsection keys to scope the edit more narrowly (e.g. { demographics: ['ageRange'] })."),
      brandId: brandOpt,
    },
    async ({ prompt, sections, subsections, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { prompt, sections };
      if (subsections !== undefined) body.subsections = subsections;
      try {
        const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/brands/${id}/audience`, body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...data,
                note: "Async ai-edit started. Poll get_job(operationId) until state is 'completed' (or 'failed'/'cancelled').",
              }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "already_running",
                  message:
                    "An audience edit is already running for this brand. Wait for it to finish before starting another. Use list_operations (kind='brand_audience_review_edit') or get_job to find and poll the in-flight edit.",
                }),
              },
            ],
          };
        }
        throw err;
      }
    }
  );
}
