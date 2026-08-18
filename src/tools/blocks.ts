/**
 * Custom side-page block tools (feature 105 — Custom Side Pages / Block Model).
 *
 * Wraps five agent-v1 routes built concurrently by a sibling agent (D2) —
 * they may not exist yet on the server at the time this file is written:
 *
 *   GET    /api/agent/v1/brands/{brandId}/block-types
 *   POST   /api/agent/v1/landing-pages/{slug}/side-pages/{sideKey}/blocks
 *   PATCH  /api/agent/v1/landing-pages/{slug}/side-pages/{sideKey}/blocks/{blockId}
 *   DELETE /api/agent/v1/landing-pages/{slug}/side-pages/{sideKey}/blocks/{blockId}
 *   PUT    /api/agent/v1/landing-pages/{slug}/side-pages/{sideKey}/blocks/order
 *
 * These are thin wrappers over PostKing's `src/services/blocks/blockCrud.ts`
 * (addBlock/editBlock/deleteBlock/reorderBlocks — read directly from the
 * PostKing working tree while building this file, since D2's route files
 * didn't exist yet). Request bodies below mirror that service's input
 * shapes field-for-field (`type`, `props`, `position`, `orderedBlockIds`),
 * since D2's routes are documented as "thin wrappers ... no business logic
 * in route files" and are expected to pass the request body straight
 * through. **This is the one part of this file that cannot be verified
 * against a live server — see the module-level caveat in the D3 report.**
 *
 * A custom side page's content is `overrides.blocks[]`, an ordered array of
 * `{ id: "blk_xxxxxxxx", type, props }` (`02-block-contract.md` §1/§8).
 * Three tiers of `type`:
 *   - Tier 1: one of the 12 existing Uland sections (hero, showcase, videos,
 *     howItWorks, features, categoryExplorer, replacesStack, comparisonMatrix,
 *     cta, faq, pricing, roiCalculator) — `props` matches that section's
 *     existing content shape.
 *   - Tier 2: a DB-seeded `BlockType` key (e.g. "servicesGrid") — `props`
 *     must match that type's JSON Schema (see `list_block_types`).
 *   - Tier 3: the literal type `"html"` — `props` is `{ html: "<section
 *     class=\"blk-section\">...</section>" }`, sanitized server-side
 *     (`02-block-contract.md` §5). The sanitizer REJECTS invalid markup
 *     with a reason (never silently strips) — retry with the reason folded
 *     into the next attempt.
 *
 * Every write (add/edit/delete/reorder) is a full-snapshot version create,
 * fenced by an optimistic-concurrency check on the server
 * (`BlockConcurrentModificationError` → HTTP 409 expected). All four write
 * tools here catch a 409 and return an actionable retry instruction instead
 * of throwing a raw envelope — see `concurrentModificationResult` below.
 *
 * Security note (inherited from the sanitizer review): validation `reason`
 * strings returned by the server may embed attacker-influenced substrings
 * (e.g. a snippet of rejected HTML). This file never builds HTML from them —
 * every response here is `JSON.stringify`'d plain text — and no tool in
 * this file should ever be changed to render one as markup.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, pick, type Projector } from "../detail.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

/**
 * Arbitrary JSON value for block props fields. Mirrors `jsonValueSchema` in
 * `lp.ts` (`set_landing_page_section`/`set_side_page_section`) — deliberately
 * NOT `z.any()`, which renders as an untyped `{}` JSON-schema node that some
 * MCP clients pre-stringify (corrupting arrays/objects on the wire).
 */
const jsonValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.any()),
  z.record(z.string(), z.any()),
]);

/** Same defensive unwrap as `lp.ts`'s `coerceJsonValue` — some agent
 * runtimes stringify object/array tool args before sending. If `value` is a
 * string that looks like (and parses as) JSON, unwrap it once. */
function coerceJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// ── Shared error handling for block writes ──────────────────────────────────

/**
 * Every block write goes through the server's optimistic-concurrency fence
 * (`expectedCurrentVersionId` in `createSidePageVersion`) and throws a 409 on
 * conflict when two writers touch the same side page between read and write —
 * a real risk for MCP/agent clients issuing several block edits back to back.
 * Surface it as plain-text guidance, not a raw envelope dump.
 */
function isConcurrentModification(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409;
}

function concurrentModificationResult(sideKey: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "concurrent_modification",
          message:
            `Side page "${sideKey}" was modified by another write between your last read and this call. ` +
            "Call view_side_page again to re-fetch the current blocks, then retry this edit against the fresh state. " +
            "Do not blindly retry the same call — another writer's change may need to be accounted for.",
        }),
      },
    ],
  };
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface BlockTypeCatalogEntry {
  key?: string;
  tier?: 1 | 2;
  version?: number;
  brandId?: string | null;
  name?: string;
  description?: string;
  category?: string;
  jsonSchema?: Record<string, unknown>;
  /** Present only for Tier 2 entries. */
  template?: string;
  [k: string]: unknown;
}

const blockTypeProj: Projector<BlockTypeCatalogEntry> = {
  short: (r) => pick(r, ["key", "tier", "name", "category"]),
  medium: (r) => ({
    ...pick(r, ["key", "tier", "version", "name", "category", "description"]),
    hasTemplate: typeof r.template === "string",
  }),
};

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerBlockTools(server: McpServer) {
  // ── List block types (discovery) ──────────────────────────────────────────
  server.tool(
    "list_block_types",
    [
      "List the block catalog available for custom side pages: Tier 1 (the 12 built-in Uland sections) merged with Tier 2 (brand-visible `BlockType` rows seeded in the DB) — this ONE call is the entire runtime discovery mechanism for what add_block accepts.",
      "A Tier 2 type added to the database is usable immediately, with no MCP server rebuild — always call this before composing a custom page rather than assuming a fixed list.",
      "detail='short' (default) gives {key,tier,name,category}; 'medium' adds version/description/hasTemplate; 'full' includes the complete jsonSchema (and template for Tier 2) — use 'full' to see exactly what shape `props` must have for a given type before calling add_block/edit_block.",
      "Tier 3 (`type: \"html\"`) is NOT listed here — it's always available, with `props: { html: \"<section class=\\\"blk-section\\\">...</section>\" }`, sanitized server-side against the blk-* CSS vocabulary and a strict tag/attribute allowlist.",
    ].join(" "),
    {
      brandId: brandOpt,
      detail: detailParam("short"),
    },
    async ({ brandId, detail }) => {
      const id = requireBrandId(brandId);
      const raw = await api.get<Record<string, unknown>>(
        `/api/agent/v1/brands/${id}/block-types`
      );
      const entries: BlockTypeCatalogEntry[] = Array.isArray(raw["blockTypes"])
        ? (raw["blockTypes"] as BlockTypeCatalogEntry[])
        : Array.isArray(raw["catalog"])
        ? (raw["catalog"] as BlockTypeCatalogEntry[])
        : Array.isArray(raw)
        ? (raw as unknown as BlockTypeCatalogEntry[])
        : [];
      const text = JSON.stringify({
        count: entries.length,
        detail,
        blockTypes: projectList(detail, entries, blockTypeProj),
      });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Add block ──────────────────────────────────────────────────────────────
  server.tool(
    "add_block",
    [
      "Add one block to a custom side page's `blocks[]` array. `type` must be a key from list_block_types (Tier 1/2), or the literal \"html\" (Tier 3, sanitized server-side).",
      "`props` must match that type's schema exactly — call list_block_types(detail='full') first to see the required shape; a mismatch is rejected (not silently coerced) and the error names the offending field.",
      "`position` is a 0-based insert index into the CURRENT blocks array; omit to append at the end. Out-of-range values clamp to the nearest valid index.",
      "The server generates and returns the new block's id (`blk_xxxxxxxx`) — you don't choose it. Creates a new draft version on the side page (see list_side_page_versions); on a published page this stays draft-only until set_side_page_state({published:true}).",
      "For html blocks, use only the blk-* CSS classes from the block contract (no Tailwind, no inline standard CSS, no <script>/<style>/<img> — <img> is emitted exclusively by the {{#img}} template construct on Tier 2 types, never hand-written).",
    ].join(" "),
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages) — must be a type:\"custom\" side page"),
      type: z
        .string()
        .min(1)
        .describe("Block type key from list_block_types (Tier 1/2), or \"html\" for a Tier 3 sanitized HTML block"),
      props: z
        .record(z.string(), jsonValueSchema)
        .describe(
          "Block props, matching the type's schema (see list_block_types detail='full'). For type=\"html\" this is { html: \"<section class=...>...</section>\" }."
        ),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0-based insert index in the current blocks array. Omit to append at the end."),
    },
    async ({ slug, sideKey, type, props, position }) => {
      const body: Record<string, unknown> = { type, props: coerceJsonValue(props) };
      if (position !== undefined) body.position = position;
      try {
        const data = await api.post<Record<string, unknown>>(
          `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/blocks`,
          body
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        if (isConcurrentModification(err)) return concurrentModificationResult(sideKey);
        throw err;
      }
    }
  );

  // ── Edit block ─────────────────────────────────────────────────────────────
  server.tool(
    "edit_block",
    [
      "Edit an existing block on a custom side page. Pass `props` to replace that block's ENTIRE props object (not a shallow merge — it must satisfy the type's full schema, same as add_block), and/or `type` to change which block type this block resolves to (props is then revalidated against the NEW type's schema — pass matching props in the same call, don't rely on the old props still being valid).",
      "Fetch the block's current props first via view_side_page(detail='full') (look under overrides.blocks) if you only want to change one field — merge locally, then send the full object back.",
      "Creates a new draft version. On a published page this stays draft-only until set_side_page_state({published:true}).",
    ].join(" "),
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages)"),
      blockId: z.string().describe("Block id (blk_xxxxxxxx) from view_side_page's overrides.blocks"),
      type: z
        .string()
        .min(1)
        .optional()
        .describe("New block type key. When changing type, also pass `props` matching the new type's schema."),
      props: z
        .record(z.string(), jsonValueSchema)
        .optional()
        .describe("Replacement props object for this block — the FULL object, matching the (possibly new) type's schema, not a partial patch."),
    },
    async ({ slug, sideKey, blockId, type, props }) => {
      if (type === undefined && props === undefined) {
        throw new Error("Pass at least one of `type` or `props`.");
      }
      const body: Record<string, unknown> = {};
      if (type !== undefined) body.type = type;
      if (props !== undefined) body.props = coerceJsonValue(props);
      try {
        const data = await api.patch<Record<string, unknown>>(
          `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/blocks/${blockId}`,
          body
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        if (isConcurrentModification(err)) return concurrentModificationResult(sideKey);
        if (err instanceof ApiError && err.status === 404) {
          throw new Error(
            `Block "${blockId}" not found on side page "${sideKey}". Call view_side_page(detail='full') to see current block ids under overrides.blocks.`
          );
        }
        throw err;
      }
    }
  );

  // ── Delete block ───────────────────────────────────────────────────────────
  server.tool(
    "delete_block",
    [
      "Permanently remove one block from a custom side page's blocks[] array. Pass confirm: true to proceed.",
      "Creates a new draft version — recoverable via list_side_page_versions / restore_side_page_version even after deletion, since the version history is append-only.",
    ].join(" "),
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages)"),
      blockId: z.string().describe("Block id (blk_xxxxxxxx) from view_side_page's overrides.blocks"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    },
    async ({ slug, sideKey, blockId }) => {
      try {
        const data = await api.delete<Record<string, unknown>>(
          `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/blocks/${blockId}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                data && Object.keys(data).length > 0
                  ? data
                  : { deleted: true, blockId, sideKey },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (isConcurrentModification(err)) return concurrentModificationResult(sideKey);
        if (err instanceof ApiError && err.status === 404) {
          throw new Error(
            `Block "${blockId}" not found on side page "${sideKey}" — it may already be deleted. Call view_side_page(detail='full') to confirm.`
          );
        }
        throw err;
      }
    }
  );

  // ── Reorder blocks ─────────────────────────────────────────────────────────
  server.tool(
    "reorder_blocks",
    [
      "Reorder a custom side page's blocks[] array. `blockIds` must be the FULL, EXACT set of block ids the page currently has, in their new order — reorder cannot add or remove blocks (use add_block/delete_block for that) and a set mismatch is rejected.",
      "Get the current ids and order via view_side_page(detail='full') → overrides.blocks[].id before calling this.",
      "Creates a new draft version. On a published page this stays draft-only until set_side_page_state({published:true}).",
    ].join(" "),
    {
      slug: z.string().describe("Parent landing page slug"),
      sideKey: z.string().describe("Side page key (from list_side_pages)"),
      blockIds: z
        .array(z.string())
        .min(1)
        .describe("ALL of the page's current block ids, in the desired new order. Must be a permutation of the existing set — not a subset."),
    },
    async ({ slug, sideKey, blockIds }) => {
      try {
        const data = await api.put<Record<string, unknown>>(
          `/api/agent/v1/landing-pages/${slug}/side-pages/${sideKey}/blocks/order`,
          { orderedBlockIds: blockIds }
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        if (isConcurrentModification(err)) return concurrentModificationResult(sideKey);
        if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
          throw new Error(
            `${err.message} — blockIds must be exactly the page's current block ids (no add/remove), just reordered. Call view_side_page(detail='full') to get the current set.`
          );
        }
        throw err;
      }
    }
  );
}
