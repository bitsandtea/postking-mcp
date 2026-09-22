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
 *   4. Correct  → brand_truth_update (LLM-mediated: describe a correction in
 *                 plain language, or toggle pinned; PostKing's own model
 *                 decides whether/how to rewrite the entry's content)
 *   5. Reject   → brand_truth_delete (SOFT delete — keeps the row with
 *                 deletedAt set AND records rejection memory so the system
 *                 stops re-suggesting that fact)
 *   6. Undo     → brand_truth_restore (clears deletedAt and the rejection
 *                 memory brand_truth_delete recorded)
 *
 * Read-only tools: brand_truth_list, brand_truth_get.
 * Write tools:     brand_truth_create, brand_truth_update,
 *                   brand_truth_delete, brand_truth_restore.
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
  short: (r) => ({ id: r.id, name: r.name, type: r.type, pinned: r.pinned, deletedAt: r.deletedAt ?? null }),
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
    deletedAt: r.deletedAt ?? null,
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerBrandTruthTools(server: McpServer) {
  // ── brand_truth_list ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_list",
    [
      "List the brand's stored brand truths (atomic facts/observations used to ground generation).",
      "short {id,name,type,pinned,deletedAt}; medium adds personaScope+tags+summary+timestamps; full = raw.",
      "Filter by type, personaScope, tags (array or comma-separated), or a free-text query.",
      "By default, soft-deleted truths (brand_truth_delete) are excluded. Pass includeDeleted: true to see them too — each returned row's `deletedAt` tells live rows (null) from trashed ones (a timestamp) apart. Restore a trashed one with brand_truth_restore.",
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
      includeDeleted: z.boolean().optional().describe("Include soft-deleted truths (deletedAt set) alongside live ones. Defaults to false (live only)."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ type, query, personaScope, tags, limit, includeDeleted, detail, brandId }) => {
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
      if (includeDeleted) qs.set("includeDeleted", "true");
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
      "Correct or pin/unpin an existing, known brand truth (by ID).",
      "Brand truths are maintained by PostKing's OWN model, not written directly by callers — you cannot set name/description/content/type/tags/personaScope yourself.",
      "Describe the correction in plain language via `correction` (e.g. \"the pricing is $49 not $39\", \"this only applies to the professional persona\", \"reword: say it plainer\") and PostKing's model reads the existing entry, decides whether the correction is a real, verifiable, on-topic, non-duplicate change, and rewrites exactly the fields that need to change.",
      "The model may refuse: it returns { applied: false, reason } when the correction isn't about this entry, is speculation/marketing fluff, contradicts strong evidence, or asks to change nothing.",
      "`pinned` is a separate, direct toggle (true/false) — it does not touch content and is never refused.",
      "Pass at least one of `correction`/`pinned`. If both are given, the correction is applied first, then the pin toggle.",
      "To capture a brand-new fact instead of correcting this one, use brand_truth_create.",
    ].join(" "),
    {
      id: z.string().describe("Brand truth entry ID to update."),
      correction: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          "Plain-language description of what's wrong or what should change about this ONE entry (≤2000 chars). PostKing's model reads the existing entry plus this correction and decides whether/how to rewrite it. It may refuse — check `applied` in the response; when false, `reason` explains why."
        ),
      pinned: z.boolean().optional().describe("Pin (true) or unpin (false) this truth. Direct toggle, independent of `correction`, never refused."),
      brandId: brandOpt,
    },
    async ({ id: entryId, correction, pinned, brandId }) => {
      if (correction === undefined && pinned === undefined) {
        throw new Error("Pass at least one of `correction` or `pinned`.");
      }
      const id = requireBrandId(brandId);
      const result: Record<string, unknown> = {};

      if (correction !== undefined) {
        const data = await api.post<unknown>(
          `/api/agent/v1/brands/${id}/brand-truth/${entryId}/revise`,
          { correction }
        );
        const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        result.applied = raw.applied ?? false;
        if (raw.entry !== undefined) result.entry = raw.entry;
        if (raw.changed !== undefined) result.changed = raw.changed;
        if (raw.reason !== undefined) result.reason = raw.reason;
      }

      if (pinned !== undefined) {
        const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/brand-truth/${entryId}`, { pinned });
        const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        if (raw.entry !== undefined) result.entry = raw.entry;
        if (result.applied === undefined) result.applied = true;
        result.pinned = pinned;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── brand_truth_delete ─────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_delete",
    [
      "SOFT-delete a brand truth by ID — the row is kept (deletedAt is set) and is undoable with brand_truth_restore, it just stops showing up in brand_truth_list/brand_truth_get by default (pass includeDeleted: true to see it) and stops being used to ground generation.",
      "This also records rejection memory: the system learns to stop re-suggesting that fact during future extractions, even while it's trashed.",
      "Use it deliberately — deleting a truth teaches PostKing that the fact should not come back. If you got it wrong, brand_truth_restore undoes both the deletion and the rejection memory.",
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

  // ── brand_truth_restore ────────────────────────────────────────────────────────
  server.tool(
    "brand_truth_restore",
    "Undo a brand_truth_delete: clears the entry's deletedAt (making it live again — it reappears in default brand_truth_list/brand_truth_get results and resumes grounding generation) and clears the rejection memory that delete recorded, so the fact is no longer suppressed from future extractions.",
    {
      id: z.string().describe("Brand truth entry ID to restore (find trashed entries with brand_truth_list(includeDeleted: true))."),
      brandId: brandOpt,
    },
    async ({ id: entryId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/brand-truth/${entryId}/restore`, {});
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      return { content: [{ type: "text" as const, text: JSON.stringify(raw.entry ?? raw) }] };
    }
  );
}
