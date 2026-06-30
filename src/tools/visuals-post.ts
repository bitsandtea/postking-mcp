import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { detailParam, projectList, truncate, type Detail, type Projector } from "../detail.js";
import { getActiveBrandId } from "../state.js";
import { visualEditorUrl } from "../links.js";

// Slim a visual option item: keep pickArgs, drop templateParams and _internal
function slimVisualOption(item: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  const keep = ["slot", "kind", "style", "variant", "displayLabel", "recommended", "pickArgs"] as const;
  for (const k of keep) {
    if (item[k] !== undefined) slim[k] = item[k];
  }
  return slim;
}

// Recursively collect visual option items from a catalog object.
// An item is recognized by having slot/kind/pickArgs/templateParams/_internal.
function collectSlimOptions(val: unknown, visited = new WeakSet<object>()): Record<string, unknown>[] {
  if (!val || typeof val !== "object") return [];
  if (visited.has(val as object)) return [];
  visited.add(val as object);
  if (Array.isArray(val)) {
    const results: Record<string, unknown>[] = [];
    for (const item of val) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const it = item as Record<string, unknown>;
        if ("slot" in it || "kind" in it || "pickArgs" in it || "templateParams" in it || "_internal" in it) {
          results.push(slimVisualOption(it));
        } else {
          results.push(...collectSlimOptions(item, visited));
        }
      }
    }
    return results;
  }
  // Object: skip bestPick key, recurse into other values
  const d = val as Record<string, unknown>;
  const results: Record<string, unknown>[] = [];
  for (const [key, v] of Object.entries(d)) {
    if (key === "bestPick") continue;
    results.push(...collectSlimOptions(v, visited));
  }
  return results;
}

// Project a visual catalog response
function projectVisualCatalog(detail: Detail, data: unknown): unknown {
  if (detail === "full") return data;
  const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (detail === "short") {
    const bp = d.bestPick;
    const bestPick = bp && typeof bp === "object" ? (bp as Record<string, unknown>).id ?? null : bp ?? null;
    // Count items per known bucket (may be nested under byPlatform or options or directly)
    const BUCKETS = ["smart", "card", "quote", "photo", "video"] as const;
    const counts: Record<string, number> = {};
    function addCounts(obj: unknown): void {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return;
      const o = obj as Record<string, unknown>;
      for (const bucket of BUCKETS) {
        if (Array.isArray(o[bucket])) {
          counts[bucket] = (counts[bucket] ?? 0) + (o[bucket] as unknown[]).length;
        }
      }
      for (const [k, v] of Object.entries(o)) {
        if (!BUCKETS.includes(k as typeof BUCKETS[number]) && v && typeof v === "object" && !Array.isArray(v)) {
          addCounts(v);
        }
      }
    }
    addCounts(d);
    return { bestPick, counts };
  }
  // medium: flat slim option list
  return collectSlimOptions(data);
}

// Medium card shape
function mediumCard(card: Record<string, unknown>, i: number): Record<string, unknown> {
  return {
    id: card.id,
    index: (card.index as number | undefined) ?? i + 1,
    title: card.title,
    body: truncate(card.body, 200),
  };
}

function extractCards(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const arr = Array.isArray(d.cards) ? d.cards : Array.isArray(data) ? data : [];
  return (arr as unknown[]).filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}

export function registerVisualsPostTools(server: McpServer) {
  // ── Generate post visual options ──────────────────────────────────────────
  server.tool(
    "generate_post_visual_options",
    [
      "Fetch available visual options for a post — card templates, library matches, stock photos.",
      "Returns a bestPick recommendation plus categorized options per platform.",
      "Use pick_post_visual to apply one of the returned options.",
      "Returns slim option list with pickArgs by default (medium). Use detail='short' for counts only, 'full' for raw catalog.",
      "Includes editInVisualEditor: a direct URL to edit the post in the visual editor (when active brand is set).",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().optional().describe("Filter to a specific platform, e.g. 'linkedin'"),
      category: z
        .enum(["smart", "card", "quote", "photo", "video"])
        .optional()
        .describe("Filter by visual category"),
      detail: detailParam("medium"),
    },
    async ({ postId, platform, category, detail }) => {
      const params = new URLSearchParams();
      if (platform) params.set("platform", platform);
      if (category) params.set("category", category);
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<unknown>(`/api/agent/v1/posts/${postId}/visuals${qs}`);
      const activeBrandId = getActiveBrandId();
      const projected = projectVisualCatalog(detail, data);
      const result = activeBrandId && platform
        ? { ...(typeof projected === "object" && projected !== null && !Array.isArray(projected) ? projected as Record<string, unknown> : { data: projected }), editInVisualEditor: visualEditorUrl(activeBrandId, postId, platform) }
        : projected;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Regenerate visual options ─────────────────────────────────────────────
  server.tool(
    "regenerate_post_visual",
    "Regenerate the visual option set for a post — refreshes stock photo results and re-scores library assets. Returns slim option list with pickArgs by default (medium). Use detail='short' for counts only, 'full' for raw catalog. Includes editInVisualEditor: a direct URL to edit the post in the visual editor (when active brand is set).",
    {
      postId: z.string().describe("Post ID"),
      loadExternal: z.boolean().optional().default(false).describe("Also reload external stock sources"),
      platform: z.string().optional().describe("Limit regeneration to a specific platform"),
      detail: detailParam("medium"),
    },
    async ({ postId, loadExternal, platform, detail }) => {
      const body: Record<string, unknown> = {};
      if (loadExternal) body.loadExternal = true;
      if (platform) body.platform = platform;
      const data = await api.post<unknown>(
        `/api/agent/v1/posts/${postId}/visuals/regenerate`,
        body
      );
      const activeBrandId = getActiveBrandId();
      const projected = projectVisualCatalog(detail, data);
      const result = activeBrandId && platform
        ? { ...(typeof projected === "object" && projected !== null && !Array.isArray(projected) ? projected as Record<string, unknown> : { data: projected }), editInVisualEditor: visualEditorUrl(activeBrandId, postId, platform) }
        : projected;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Pick post visual ──────────────────────────────────────────────────────
  server.tool(
    "pick_post_visual",
    [
      "Select a visual for a post on a given platform.",
      "Use the chosen option's `pickArgs` from generate_post_visual_options VERBATIM —",
      "for card/quote templates that means passing kind + style + variant together;",
      "for a library/smart asset or a stock photo, pass the assetId or slot from its pickArgs.",
      "Do not invent style names. variant is a 1-based template variant index.",
      "Includes editInVisualEditor: a direct URL to edit the post in the visual editor (when active brand is set).",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().describe("Target platform, e.g. 'linkedin'"),
      kind: z
        .enum(["smart", "quote", "card", "photo", "video"])
        .optional()
        .describe(
          "Visual kind, taken verbatim from the chosen option's pickArgs. REQUIRED when picking a card or quote template style (e.g. kind:'quote' with style:'gradient-bold'). If omitted, the server assumes 'card' and will reject quote styles."
        ),
      style: z.string().optional().describe("Template style name from generate_post_visual_options"),
      variant: z.number().int().optional().describe("Template variant index"),
      assetId: z.string().optional().describe("Library asset ID from list_assets"),
      slot: z.string().optional().describe("Internal template slot key (advanced)"),
    },
    async ({ postId, platform, kind, style, variant, assetId, slot }) => {
      if (!style && !assetId && !slot) {
        return {
          content: [{ type: "text" as const, text: "Provide one of: style, assetId, or slot." }],
        };
      }
      const pick: Record<string, unknown> = {};
      if (kind) pick.kind = kind;
      if (style) pick.style = style;
      if (variant !== undefined) pick.variant = variant;
      if (assetId) pick.assetId = assetId;
      if (slot) pick.slot = slot;
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/visuals`, {
        platform,
        pick,
      });
      const activeBrandId = getActiveBrandId();
      const baseResult = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { data };
      const result = activeBrandId
        ? { ...baseResult, editInVisualEditor: visualEditorUrl(activeBrandId, postId, platform) }
        : baseResult;
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Clear post visual ─────────────────────────────────────────────────────
  server.tool(
    "clear_post_visual",
    "Remove the selected visual from a post for a specific platform. Includes editInVisualEditor: a direct URL to edit the post in the visual editor (when active brand is set).",
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().describe("Platform to clear the visual for, e.g. 'linkedin'"),
    },
    async ({ postId, platform }) => {
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/visuals`, {
        platform,
        pick: { clear: true },
      });
      const activeBrandId = getActiveBrandId();
      const baseResult = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { data };
      const result = activeBrandId
        ? { ...baseResult, editInVisualEditor: visualEditorUrl(activeBrandId, postId, platform) }
        : baseResult;
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── List post cards ───────────────────────────────────────────────────────
  server.tool(
    "list_post_cards",
    "List the carousel cards attached to a post. Cards are used for LinkedIn carousel / PDF generation. Returns {index,title} by default; use detail='medium' for truncated body, 'full' for all fields.",
    {
      postId: z.string().describe("Post ID"),
      detail: detailParam("short"),
    },
    async ({ postId, detail }) => {
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/cards`);
      const cards = extractCards(data);
      const cardProjector: Projector<Record<string, unknown>> = {
        short: (c) => ({ id: c.id, index: c.index, title: c.title }),
        medium: (c) => ({ id: c.id, index: c.index, title: c.title, body: truncate(c.body, 200) }),
      };
      const text = JSON.stringify({ count: cards.length, detail, cards: projectList(detail, cards, cardProjector) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── Edit a single card ────────────────────────────────────────────────────
  server.tool(
    "edit_post_card",
    [
      "Edit a single carousel card on a post by its 1-based index.",
      "Provide title and/or body to update. Set rerender=true to regenerate the visual asset.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      cardIndex: z.number().int().min(1).describe("1-based card index (1 = first card)"),
      title: z.string().optional().describe("Card title"),
      body: z.string().optional().describe("Card body text"),
      number: z.string().optional().describe("Card number label"),
      rerender: z.boolean().optional().default(false).describe("Regenerate visual assets after edit"),
    },
    async ({ postId, cardIndex, title, body, number, rerender }) => {
      // Fetch existing cards first so we can do a targeted patch
      const getRes = await api.get<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/cards`);
      const existingCards = Array.isArray(getRes.cards) ? getRes.cards as Record<string, unknown>[] : [];
      if (cardIndex > existingCards.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Post ${postId} has ${existingCards.length} card(s); cardIndex ${cardIndex} is out of range.`,
            },
          ],
        };
      }
      const updated = existingCards.map((card: Record<string, unknown>, i: number) => {
        if (i === cardIndex - 1) {
          return {
            ...card,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(number !== undefined ? { number } : {}),
          };
        }
        return card;
      });
      const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/cards`, {
        cards: updated,
        rerender,
      });
      const resultCards = extractCards(data);
      const trimmed = resultCards.map((c, i) => mediumCard(c, i));
      return { content: [{ type: "text" as const, text: JSON.stringify(trimmed) }] };
    }
  );

  // ── Bulk-replace cards ────────────────────────────────────────────────────
  server.tool(
    "set_post_cards",
    "Bulk-replace all carousel cards for a post. Provide a full array of card objects with title, body, and optional number.",
    {
      postId: z.string().describe("Post ID"),
      cards: z
        .array(
          z.object({
            title: z.string().optional(),
            body: z.string().optional(),
            number: z.string().optional(),
          })
        )
        .describe("Full replacement array of card objects"),
      rerender: z.boolean().optional().default(false).describe("Regenerate visual assets after update"),
    },
    async ({ postId, cards, rerender }) => {
      const data = await api.patch<Record<string, unknown>>(`/api/agent/v1/posts/${postId}/cards`, {
        cards,
        rerender,
      });
      const resultCards = extractCards(data);
      const trimmed = resultCards.map((c, i) => mediumCard(c, i));
      return { content: [{ type: "text" as const, text: JSON.stringify(trimmed) }] };
    }
  );

  // ── Generate carousel PDF ─────────────────────────────────────────────────
  server.tool(
    "generate_post_carousel",
    [
      "Generate a carousel PDF for a LinkedIn (or other) post from the post's cards.",
      "Returns an asset ID and download URL for the PDF.",
      "Requires cards to be set first via set_post_cards or edit_post_card.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      style: z.string().optional().describe("Card template style name"),
      variant: z.number().int().optional().describe("Template variant index"),
      title: z.string().optional().describe("Carousel title override"),
    },
    async ({ postId, style, variant, title }) => {
      const body: Record<string, unknown> = {};
      if (style) body.style = style;
      if (variant !== undefined) body.variant = variant;
      if (title) body.title = title;
      const data = await api.post<any>(`/api/agent/v1/posts/${postId}/carousel`, body);
      const asset = data?.asset ?? data;
      return { content: [{ type: "text" as const, text: JSON.stringify(asset, null, 2) }] };
    }
  );
}
