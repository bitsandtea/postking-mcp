import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";
import { etaFor } from "../etas.js";

/**
 * Knowledge Base tools.
 *
 * Canonical agent flow (see `manage_knowledge_base` guided prompt):
 *   1. Browse   → knowledge_list
 *   2. Inspect  → knowledge_get
 *   3. Add      → knowledge_create (async; poll get_job until state=completed)
 *   4. Edit     → knowledge_update (sync for minor edits; async w/ get_job when content changed significantly)
 *   5. Retire   → knowledge_delete (soft-delete; item no longer appears in list)
 *
 * Read-only tools: knowledge_list, knowledge_get.
 * Write tools:     knowledge_create, knowledge_update, knowledge_delete.
 */

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Projectors ────────────────────────────────────────────────────────────────

const kbProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, name: r.name, contentType: r.contentType }),
  medium: (r) => ({
    id: r.id,
    name: r.name,
    contentType: r.contentType,
    isGlobal: r.isGlobal,
    tags: r.tags,
    summary: truncate(r.description as unknown, 160),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerKnowledgeTools(server: McpServer) {
  // ── knowledge_list ───────────────────────────────────────────────────────────
  server.tool(
    "knowledge_list",
    [
      "List the brand's knowledge-base items.",
      "short {id,name,contentType}; medium adds tags+summary+timestamps; full = raw.",
      "Filter by tag, active status, or global scope.",
    ].join(" "),
    {
      tag: z.string().optional().describe("Filter by tag (exact match)."),
      activeOnly: z.boolean().optional().describe("When true, only return active (non-soft-deleted) items. Defaults to true on the backend."),
      global: z.boolean().optional().describe("When true, only return account-wide (isGlobal) items."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ tag, activeOnly, global, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (tag) qs.set("tag", tag);
      if (activeOnly !== undefined) qs.set("active", String(activeOnly));
      if (global !== undefined) qs.set("global", String(global));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/knowledge${suffix}`);
      // Defensive: agent-v1 may return { items: [...] } or a raw array (inner route returns array).
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
              items: projectList(detail, rows, kbProj),
            }),
          },
        ],
      };
    }
  );

  // ── knowledge_create ─────────────────────────────────────────────────────────
  server.tool(
    "knowledge_create",
    (() => {
      const eta = etaFor("brand_knowledge_create");
      return [
        "Async. Create a new knowledge-base item for the brand.",
        "Returns { operationId, status } — poll get_job until state=completed.",
        "If description or tags are omitted, PostKing auto-generates them from the content.",
        "For contentType='json', content must be valid JSON — this tool validates client-side before calling the API.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      name: z.string().min(1).describe("Human-readable name for the knowledge item (e.g. 'Brand Voice Guidelines')."),
      description: z.string().optional().describe("Optional short description. If omitted, PostKing auto-generates one from the content."),
      contentType: z.enum(["text", "json"]).describe("Content format: 'text' for prose/markdown, 'json' for structured data."),
      content: z.string().min(1).describe("The full content body. Must be valid JSON string when contentType='json'."),
      tags: z.array(z.string()).optional().describe("Optional tags for filtering (e.g. ['brand', 'voice']). Auto-generated if omitted."),
      isGlobal: z.boolean().optional().describe("Mark as account-wide knowledge (shared across all the user's brands)"),
      brandId: brandOpt,
    },
    async ({ name, description, contentType, content, tags, isGlobal, brandId }) => {
      // Client-side JSON validation for contentType='json' — guidance before hitting the API.
      if (contentType === "json") {
        try {
          JSON.parse(content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "invalid_json",
                  message: `content is not valid JSON: ${msg}`,
                  hint: "Fix the JSON and retry. Use contentType='text' if you want to store raw text.",
                }),
              },
            ],
          };
        }
      }
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { name, contentType, content };
      if (description !== undefined) body.description = description;
      if (tags !== undefined) body.tags = tags;
      if (isGlobal !== undefined) body.isGlobal = isGlobal;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/knowledge`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── knowledge_get ────────────────────────────────────────────────────────────
  server.tool(
    "knowledge_get",
    [
      "Fetch a single knowledge-base item by ID.",
      "short {id,name,contentType}; medium adds tags+summary+timestamps; full = raw (includes full content).",
      "Use detail='full' to retrieve the complete content body.",
    ].join(" "),
    {
      itemId: z.string().describe("KnowledgeBase item ID to retrieve."),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ itemId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/knowledge/${itemId}`);
      const row = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(project(detail, row, kbProj)),
          },
        ],
      };
    }
  );

  // ── knowledge_update ─────────────────────────────────────────────────────────
  server.tool(
    "knowledge_update",
    (() => {
      const eta = etaFor("brand_knowledge_update");
      return [
        "Update a knowledge-base item.",
        "Minor edits (name, tags, description) return the updated item synchronously.",
        "When content changes significantly, PostKing queues an AI description regeneration and returns { operationId, status } — poll get_job until state=completed.",
        "For contentType='json', content must be valid JSON — this tool validates client-side before calling the API.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      itemId: z.string().describe("KnowledgeBase item ID to update."),
      name: z.string().min(1).optional().describe("Updated name."),
      description: z.string().nullable().optional().describe("Updated description. Pass null to clear it."),
      contentType: z.enum(["text", "json"]).optional().describe("Updated content format. Must still match the content body."),
      content: z.string().min(1).optional().describe("Updated content body. Must be valid JSON when contentType (new or existing) is 'json'."),
      tags: z.array(z.string()).optional().describe("Replacement tag list. Pass [] to clear all tags."),
      brandId: brandOpt,
    },
    async ({ itemId, name, description, contentType, content, tags, brandId }) => {
      // Client-side JSON validation when content is being updated with json contentType.
      if (content && contentType === "json") {
        try {
          JSON.parse(content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "invalid_json",
                  message: `content is not valid JSON: ${msg}`,
                  hint: "Fix the JSON and retry.",
                }),
              },
            ],
          };
        }
      }
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (contentType !== undefined) body.contentType = contentType;
      if (content !== undefined) body.content = content;
      if (tags !== undefined) body.tags = tags;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/knowledge/${itemId}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── knowledge_delete ─────────────────────────────────────────────────────────
  server.tool(
    "knowledge_delete",
    [
      "Soft-delete a knowledge-base item.",
      "The item is deactivated (isActive=false) and no longer appears in knowledge_list.",
      "This action is not reversible via the API.",
    ].join(" "),
    {
      itemId: z.string().describe("KnowledgeBase item ID to soft-delete."),
      brandId: brandOpt,
    },
    async ({ itemId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(`/api/agent/v1/brands/${id}/knowledge/${itemId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { ok: true }) }] };
    }
  );
}
