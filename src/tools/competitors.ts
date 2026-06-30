import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";
import { brandDashboardUrl } from "../links.js";
import { etaFor } from "../etas.js";

/**
 * Competitors intelligence tools.
 *
 * Canonical agent flow (see `competitor_intelligence` guided prompt for the
 * source of truth):
 *   1. Probe        → competitor_probe, competitor_probe_status
 *   2. Classify     → competitor_probe_classify (per candidate)
 *   3. Add          → competitor_add (batch domains)
 *   4. Analyze      → competitor_analyze (async; poll get_job)
 *   5. Comparison   → competitor_get_comparison / competitor_recompute_comparison
 *   6. Overview     → competitor_get_overview / competitor_generate_overview (async; poll get_job)
 *
 * Read-only tools: competitor_list, competitor_get_comparison, competitor_get_overview,
 *   competitor_probe_status, competitor_comparison_sources.
 * Write tools: competitor_add, competitor_update, competitor_delete, competitor_analyze,
 *   competitor_refresh, competitor_recompute_comparison, competitor_generate_overview,
 *   competitor_probe, competitor_probe_classify.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Projectors ────────────────────────────────────────────────────────────────

const competitorProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    id: r.id,
    domain: r.domain,
    analysisState: r.analysisState,
  }),
  medium: (r) => ({
    id: r.id,
    domain: r.domain,
    analysisState: r.analysisState,
    source: r.source,
    creditsCharged: r.creditsCharged,
    lastError: r.lastError,
    addedAt: r.addedAt,
    lastCrawledAt: r.lastCrawledAt,
    cacheSource: r.cacheSource,
  }),
};

const comparisonProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    id: r.id,
    generatedAt: r.generatedAt,
    competitorCount: Array.isArray(r.competitorIds) ? (r.competitorIds as string[]).length : 0,
  }),
  medium: (r) => ({
    id: r.id,
    generatedAt: r.generatedAt,
    competitorCount: Array.isArray(r.competitorIds) ? (r.competitorIds as string[]).length : 0,
    overviewGeneratedAt: r.overviewGeneratedAt,
    overviewSummary: r.overviewSummary,
  }),
};

const overviewProj: Projector<Record<string, unknown>> = {
  short: (r) => ({
    generatedAt: r.generatedAt,
    actionCount: Array.isArray(r.topActions) ? (r.topActions as unknown[]).length : 0,
  }),
  medium: (r) => ({
    generatedAt: r.generatedAt,
    topActions: r.topActions,
    summary: truncate(r.summary as unknown, 400),
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerCompetitorTools(server: McpServer) {
  // ── competitor_list ──────────────────────────────────────────────────────────
  server.tool(
    "competitor_list",
    [
      "List the brand's tracked competitors.",
      "short {id,domain,analysisState}; medium adds source,creditsCharged,lastError,addedAt,lastCrawledAt,cacheSource; full = raw.",
      "Also returns a dashboard link to the Competitors tab.",
    ].join(" "),
    { detail: detailParam("short"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/competitors`);
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const items = Array.isArray(raw.items)
        ? (raw.items as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        : [];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: items.length,
              detail,
              competitors: projectList(detail, items, competitorProj),
              dashboardUrl: brandDashboardUrl(id, "seo_competitors"),
              creditBalance: (raw as Record<string, unknown>).creditBalance,
              requiresDeleteDown: (raw as Record<string, unknown>).requiresDeleteDown,
            }),
          },
        ],
      };
    }
  );

  // ── competitor_add ───────────────────────────────────────────────────────────
  server.tool(
    "competitor_add",
    (() => {
      const eta = etaFor("competitor_batch_analyze");
      return [
        "Async. Batch-add competitor domains (1–20) to the brand.",
        "Returns { operationId, status } — poll get_job until state=completed.",
        "Each domain triggers crawl + profile analysis.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      domains: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("One to twenty competitor domains to add (e.g. ['acme.com', 'rival.io'])."),
      brandId: brandOpt,
    },
    async ({ domains, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/competitors`, { domains });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_update ────────────────────────────────────────────────────────
  server.tool(
    "competitor_update",
    [
      "Update a competitor's settings.",
      "Currently supports toggling excludeFromSeoPull (removes the domain from keyword-gap pull without deleting it).",
      "Send an empty body to restore a soft-deleted competitor.",
    ].join(" "),
    {
      competitorId: z.string().describe("BrandCompetitor ID to update."),
      excludeFromSeoPull: z
        .boolean()
        .optional()
        .describe("When true, excludes this competitor from the SEO keyword-pull. Omit to restore a soft-deleted row."),
      brandId: brandOpt,
    },
    async ({ competitorId, excludeFromSeoPull, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (excludeFromSeoPull !== undefined) body.excludeFromSeoPull = excludeFromSeoPull;
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/competitors/${competitorId}`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── competitor_delete ────────────────────────────────────────────────────────
  server.tool(
    "competitor_delete",
    [
      "Soft-delete a tracked competitor from the brand.",
      "No credits are refunded. Use competitor_update (empty body) to restore.",
    ].join(" "),
    {
      competitorId: z.string().describe("BrandCompetitor ID to delete."),
      brandId: brandOpt,
    },
    async ({ competitorId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(
        `/api/agent/v1/brands/${id}/competitors/${competitorId}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── competitor_analyze ───────────────────────────────────────────────────────
  server.tool(
    "competitor_analyze",
    (() => {
      const eta = etaFor("competitor_batch_analyze");
      return [
        "Async. Trigger analysis for existing BrandCompetitor rows that are pending or failed.",
        "Use competitor_add to create new rows; use this to retry failed ones.",
        "Returns { operationId, status } — poll get_job until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      brandCompetitorIds: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("IDs of existing BrandCompetitor rows to (re-)analyze (1–20)."),
      brandId: brandOpt,
    },
    async ({ brandCompetitorIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/analyze`,
        { brandCompetitorIds }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_refresh ───────────────────────────────────────────────────────
  server.tool(
    "competitor_refresh",
    (() => {
      const eta = etaFor("competitor_refresh_all");
      return [
        "Async. Refresh all active competitors for the brand (re-crawl + re-profile).",
        "Returns { operationId, status } — poll get_job until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/refresh-all`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_get_comparison ────────────────────────────────────────────────
  server.tool(
    "competitor_get_comparison",
    [
      "Get the brand's head-to-head competitive comparison.",
      "short {id,status,generatedAt,competitorCount}; medium adds summary+strengths+weaknesses; full = raw.",
      "Returns null when no comparison has been generated yet — use competitor_recompute_comparison to generate.",
    ].join(" "),
    { detail: detailParam("full"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/competitors/comparison`);
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const comparison = raw.comparison != null && typeof raw.comparison === "object"
        ? (raw.comparison as Record<string, unknown>)
        : null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              comparison: comparison ? project(detail, comparison, comparisonProj) : null,
            }),
          },
        ],
      };
    }
  );

  // ── competitor_recompute_comparison ──────────────────────────────────────────
  server.tool(
    "competitor_recompute_comparison",
    [
      "Trigger a fresh head-to-head comparison recompute.",
      "Use after adding or re-analyzing competitors to get an up-to-date comparison.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/comparison/recompute`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );

  // ── competitor_get_overview ──────────────────────────────────────────────────
  server.tool(
    "competitor_get_overview",
    [
      "Get the brand's competitive landscape overview.",
      "short {id,status,generatedAt}; medium adds summary excerpt; full = raw.",
      "Returns null when no overview exists — use competitor_generate_overview to create one.",
    ].join(" "),
    { detail: detailParam("full"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/competitors/overview`);
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const overview = raw.overview != null && typeof raw.overview === "object"
        ? (raw.overview as Record<string, unknown>)
        : raw.id != null
        ? raw
        : null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              overview: overview ? project(detail, overview, overviewProj) : null,
            }),
          },
        ],
      };
    }
  );

  // ── competitor_generate_overview ─────────────────────────────────────────────
  server.tool(
    "competitor_generate_overview",
    (() => {
      const eta = etaFor("competitor_overview");
      return [
        "Async. Generate the competitive landscape overview (uses ~20 credits).",
        "Returns { operationId, status } — poll get_job until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/overview`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_comparison_sources ────────────────────────────────────────────
  server.tool(
    "competitor_comparison_sources",
    [
      "List the data sources used to build the brand's competitive comparison.",
      "Returns raw source records (URLs, snippets, timestamps) — useful for auditing comparison accuracy.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/competitors/comparison/sources`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_probe ─────────────────────────────────────────────────────────
  server.tool(
    "competitor_probe",
    [
      "Start a competitor discovery probe.",
      "PostKing crawls the web to find rival domains automatically.",
      "Returns { started: true } when kicked off, or { alreadyRan, status } when a probe result already exists.",
      "Poll competitor_probe_status to check readiness, then use competitor_probe_classify to accept/reject candidates.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/probe`,
        {}
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_probe_status ──────────────────────────────────────────────────
  server.tool(
    "competitor_probe_status",
    [
      "Check the status of the competitor discovery probe.",
      "Returns { status, candidates? } — status is one of: pending | running | completed | failed.",
      "When completed, candidates contains the discovered domains ready for classification.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/competitors/probe`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── competitor_probe_classify ────────────────────────────────────────────────
  server.tool(
    "competitor_probe_classify",
    [
      "Classify a discovered (or manually added) competitor candidate.",
      "'direct' seeds a BrandCompetitor row; 'similar' and 'not_relevant' update the probe JSON only.",
      "Call once per domain. Probe must be in completed state first.",
      "Returns { candidates } — the updated full candidate list.",
    ].join(" "),
    {
      domain: z.string().min(1).describe("The competitor domain to classify (e.g. 'rival.io')."),
      classification: z
        .enum(["direct", "similar", "not_relevant"])
        .describe(
          "'direct' = head-to-head competitor (adds to tracked list); 'similar' = adjacent market; 'not_relevant' = not a competitor."
        ),
      name: z
        .string()
        .optional()
        .describe("Optional human-readable name for the competitor (used when adding manually)."),
      brandId: brandOpt,
    },
    async ({ domain, classification, name, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { domain, classification };
      if (name !== undefined) body.name = name;
      const data = await api.post<unknown>(
        `/api/agent/v1/brands/${id}/competitors/probe/classify`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
