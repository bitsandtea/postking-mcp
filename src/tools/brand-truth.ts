import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";

/**
 * Brand Truth tools.
 *
 * Brand truths are atomic, durable facts/observations about a brand (hard facts,
 * audience truths, strategy notes, negative space, content insights, topics) that
 * PostKing mines from free-form text and reuses to ground generation.
 *
 * Canonical agent flow:
 *   1. Browse   → brand_truth_list
 *   2. Inspect  → brand_truth_get
 *   3. Add      → brand_truth_create (describe facts in plain language; an LLM
 *                 extraction pipeline decides which atomic truths to keep/skip)
 *   4. Edit     → brand_truth_update (direct field edit; does NOT re-run the LLM)
 *   5. Reject   → brand_truth_delete (deletes AND records rejection memory so the
 *                 system stops re-suggesting that fact)
 *
 * Read-only tools: brand_truth_list, brand_truth_get.
 * Write tools:     brand_truth_create, brand_truth_update, brand_truth_delete.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// Taxonomy enums (shared between list filters and direct edits). The taxonomy is
// owned by PostKing's extraction pipeline — callers do NOT pre-classify on create.
const TRUTH_TYPES = [
  "hard_fact",
  "audience_truth",
  "strategy_note",
  "negative_space",
  "content_insight",
  "topic",
] as const;

const PERSONA_SCOPES = ["personal", "professional", "both"] as const;

// ── Projectors ────────────────────────────────────────────────────────────────

const truthProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, name: r.name, type: r.type, pinned: r.pinned }),
  medium: (r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    personaScope: r.personaScope,
    pinned: r.pinned,
    tags: r.tags,
    summary: truncate(r.description as unknown, 160),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerBrandTruthTools(server: McpServer) {
  // ── brand_truth_list ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_list",
    [
      "List the brand's stored brand truths (atomic facts/observations used to ground generation).",
      "short {id,name,type,pinned}; medium adds personaScope+tags+summary+timestamps; full = raw.",
      "Filter by type, personaScope, tags (array or comma-separated), or a free-text query.",
    ].join(" "),
    {
      type: z.enum(TRUTH_TYPES).optional().describe("Filter by truth type."),
      query: z.string().optional().describe("Free-text search across truth name/content."),
      personaScope: z.enum(PERSONA_SCOPES).optional().describe("Filter by persona scope."),
      tags: z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe("Filter by tags. Accepts an array (['pricing','tone']) or a comma-separated string ('pricing,tone')."),
      limit: z.number().int().min(1).max(200).optional().describe("Max number of entries to return."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ type, query, personaScope, tags, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (type) qs.set("type", type);
      if (query) qs.set("query", query);
      if (personaScope) qs.set("personaScope", personaScope);
      if (tags !== undefined) {
        const csv = Array.isArray(tags) ? tags.join(",") : tags;
        if (csv) qs.set("tags", csv);
      }
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/brand-truth${suffix}`);
      // Defensive: endpoint returns { items: [...] }, but tolerate a raw array too.
      const rows: Record<string, unknown>[] = Array.isArray(data)
        ? (data as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        : (() => {
            const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
            return Array.isArray(raw.items)
              ? (raw.items as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
              : [];
          })();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: rows.length,
              detail,
              items: projectList(detail, rows, truthProj),
            }),
          },
        ],
      };
    }
  );

  // ── brand_truth_get ──────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_get",
    [
      "Fetch a single brand truth by ID.",
      "short {id,name,type,pinned}; medium adds personaScope+tags+summary+timestamps; full = raw (includes full content).",
      "Use detail='full' to retrieve the complete content body.",
    ].join(" "),
    {
      id: z.string().describe("Brand truth entry ID to retrieve."),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ id: entryId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/brand-truth/${entryId}`);
      // Tolerate either a bare entry or an { entry } envelope.
      const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const row =
        obj.entry && typeof obj.entry === "object" ? (obj.entry as Record<string, unknown>) : obj;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(project(detail, row, truthProj)),
          },
        ],
      };
    }
  );

  // ── brand_truth_create ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_create",
    [
      "Capture brand truths from plain natural-language text.",
      "Describe facts/observations about the brand in ordinary prose — a sentence or short paragraph (≤8000 chars).",
      "Do NOT pre-classify, pre-format, or guess the taxonomy: PostKing's LLM extraction pipeline reads the text and decides which atomic 'brand truths' to persist and which to skip (duplicates, too vague, or previously rejected facts).",
      "Returns { addedCount, skippedCount, added, skipped }: 'added' are the truths that were stored; 'skipped' lists each rejected quote with a reason.",
      "Review both — the skipped reasons tell you what didn't make it in and why.",
    ].join(" "),
    {
      text: z
        .string()
        .min(1)
        .max(8000)
        .describe(
          "Free-form natural-language description of facts/observations about the brand (≤8000 chars). Write it as plain prose — the extraction pipeline handles classification."
        ),
      brandId: brandOpt,
    },
    async ({ text, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/brand-truth`, { text });
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const added = Array.isArray(raw.added) ? raw.added : [];
      const skipped = Array.isArray(raw.skipped) ? raw.skipped : [];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              addedCount: added.length,
              skippedCount: skipped.length,
              added,
              skipped,
              note:
                "PostKing's extraction pipeline decided which atomic brand truths to store. 'added' were persisted; each 'skipped' entry includes a reason (e.g. duplicate, too vague, or previously rejected). Use brand_truth_update to refine a stored truth, or brand_truth_delete to remove one and stop re-suggestion.",
            }),
          },
        ],
      };
    }
  );

  // ── brand_truth_update ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_update",
    [
      "Targeted edit of an existing, known brand truth (by ID).",
      "This does NOT re-run the LLM extraction pipeline — it writes the provided fields directly.",
      "Use it to correct wording (name/description/content), fix the type/personaScope, adjust tags, or pin/unpin.",
      "To capture NEW facts from prose, use brand_truth_create instead.",
    ].join(" "),
    {
      id: z.string().describe("Brand truth entry ID to update."),
      name: z.string().min(1).optional().describe("Updated short label/name."),
      description: z.string().optional().describe("Updated description/summary."),
      content: z.string().optional().describe("Updated full content body of the truth."),
      tags: z.array(z.string()).optional().describe("Replacement tag list. Pass [] to clear all tags."),
      type: z.enum(TRUTH_TYPES).optional().describe("Reclassify the truth type."),
      personaScope: z.enum(PERSONA_SCOPES).optional().describe("Updated persona scope."),
      pinned: z.boolean().optional().describe("Pin (true) or unpin (false) this truth."),
      brandId: brandOpt,
    },
    async ({ id: entryId, name, description, content, tags, type, personaScope, pinned, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (content !== undefined) body.content = content;
      if (tags !== undefined) body.tags = tags;
      if (type !== undefined) body.type = type;
      if (personaScope !== undefined) body.personaScope = personaScope;
      if (pinned !== undefined) body.pinned = pinned;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/brand-truth/${entryId}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── brand_truth_delete ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_delete",
    [
      "Delete a brand truth by ID.",
      "This also records rejection memory: the system learns to stop re-suggesting that fact during future extractions.",
      "Use it deliberately — deleting a truth teaches PostKing that the fact should not come back.",
    ].join(" "),
    {
      id: z.string().describe("Brand truth entry ID to delete."),
      brandId: brandOpt,
    },
    async ({ id: entryId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(`/api/agent/v1/brands/${id}/brand-truth/${entryId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );
}
