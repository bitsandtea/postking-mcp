import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";

export function registerVisualsPostTools(server: McpServer) {
  // ── Generate post visual options ──────────────────────────────────────────
  server.tool(
    "generate_post_visual_options",
    [
      "Fetch available visual options for a post — card templates, library matches, stock photos.",
      "Returns a bestPick recommendation plus categorized options per platform.",
      "Use pick_post_visual to apply one of the returned options.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().optional().describe("Filter to a specific platform, e.g. 'linkedin'"),
      category: z
        .enum(["smart", "card", "quote", "photo", "video"])
        .optional()
        .describe("Filter by visual category"),
    },
    async ({ postId, platform, category }) => {
      const params = new URLSearchParams();
      if (platform) params.set("platform", platform);
      if (category) params.set("category", category);
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.get<any>(`/api/agent/v1/posts/${postId}/visuals${qs}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Regenerate visual options ─────────────────────────────────────────────
  server.tool(
    "regenerate_post_visual",
    "Regenerate the visual option set for a post — refreshes stock photo results and re-scores library assets.",
    {
      postId: z.string().describe("Post ID"),
      loadExternal: z.boolean().optional().default(false).describe("Also reload external stock sources"),
      platform: z.string().optional().describe("Limit regeneration to a specific platform"),
    },
    async ({ postId, loadExternal, platform }) => {
      const body: Record<string, unknown> = {};
      if (loadExternal) body.loadExternal = true;
      if (platform) body.platform = platform;
      const data = await api.post<any>(
        `/api/agent/v1/posts/${postId}/visuals/regenerate`,
        body
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Pick post visual ──────────────────────────────────────────────────────
  server.tool(
    "pick_post_visual",
    [
      "Select a visual for a post on a given platform.",
      "Provide one of: style (card/quote template name), assetId (library asset), or slot (internal template key).",
      "variant is a 0-based integer when selecting from a multi-variant template.",
    ].join(" "),
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().describe("Target platform, e.g. 'linkedin'"),
      style: z.string().optional().describe("Template style name from generate_post_visual_options"),
      variant: z.number().int().optional().describe("Template variant index"),
      assetId: z.string().optional().describe("Library asset ID from list_assets"),
      slot: z.string().optional().describe("Internal template slot key (advanced)"),
    },
    async ({ postId, platform, style, variant, assetId, slot }) => {
      if (!style && !assetId && !slot) {
        return {
          content: [{ type: "text" as const, text: "Provide one of: style, assetId, or slot." }],
        };
      }
      const pick: Record<string, unknown> = {};
      if (style) pick.style = style;
      if (variant !== undefined) pick.variant = variant;
      if (assetId) pick.assetId = assetId;
      if (slot) pick.slot = slot;
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/visuals`, {
        platform,
        pick,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Clear post visual ─────────────────────────────────────────────────────
  server.tool(
    "clear_post_visual",
    "Remove the selected visual from a post for a specific platform.",
    {
      postId: z.string().describe("Post ID"),
      platform: z.string().describe("Platform to clear the visual for, e.g. 'linkedin'"),
    },
    async ({ postId, platform }) => {
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/visuals`, {
        platform,
        pick: { clear: true },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── List post cards ───────────────────────────────────────────────────────
  server.tool(
    "list_post_cards",
    "List the carousel cards attached to a post. Cards are used for LinkedIn carousel / PDF generation.",
    {
      postId: z.string().describe("Post ID"),
    },
    async ({ postId }) => {
      const data = await api.get<any>(`/api/agent/v1/posts/${postId}/cards`);
      const cards = data?.cards ?? [];
      return { content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }] };
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
      const getRes = await api.get<any>(`/api/agent/v1/posts/${postId}/cards`);
      const existingCards: any[] = getRes?.cards ?? [];
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
      const updated = existingCards.map((card: any, i: number) => {
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
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/cards`, {
        cards: updated,
        rerender,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
      const data = await api.patch<any>(`/api/agent/v1/posts/${postId}/cards`, {
        cards,
        rerender,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
