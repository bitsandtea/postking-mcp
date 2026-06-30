import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";
import { etaFor } from "../etas.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

// ── Projectors ────────────────────────────────────────────────────────────────

const storylineProj: Projector<Record<string, unknown>> = {
  short: (r) => ({ id: r.id, title: r.title, status: r.status }),
  medium: (r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    isLive: r.isLive,
    storylineStartDate: r.storylineStartDate,
    storylineEndDate: r.storylineEndDate,
    launchDate: r.launchDate,
    promptSummary: truncate(r.initialPrompt, 160),
  }),
};

const lineItemProj: Projector<Record<string, unknown>> = {
  short: (li) => ({ id: li.id, channel: li.channel, type: li.type, title: li.title, selected: li.selected }),
  medium: (li) => ({
    id: li.id,
    channel: li.channel,
    type: li.type,
    title: li.title,
    description: truncate(li.description, 160),
    selected: li.selected,
    automatable: li.automatable,
    targetDate: li.targetDate,
  }),
};


// ── Tool registration ─────────────────────────────────────────────────────────

export function registerStorylineTools(server: McpServer) {
  // ── List storylines ─────────────────────────────────────────────────────────
  server.tool(
    "storyline_list",
    [
      "List the brand's storylines (marketing plans).",
      "short detail {id,title,status}; medium adds isLive, dates, promptSummary; full = raw.",
    ].join(" "),
    { detail: detailParam("short"), brandId: brandOpt },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/storylines`);
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const rows = Array.isArray(raw.items)
        ? (raw.items as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        : [];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: rows.length, detail, nextCursor: raw.nextCursor ?? null, storylines: projectList(detail, rows, storylineProj) }),
        }],
      };
    }
  );

  // ── Create a storyline ──────────────────────────────────────────────────────
  server.tool(
    "storyline_create",
    [
      "Create a new storyline (marketing plan) for the brand.",
      "Pass a prompt describing the campaign goal; optionally provide a title.",
      "After creation, call storyline_clarify to gather context, then storyline_generate_brief.",
    ].join(" "),
    {
      prompt: z.string().min(1).describe("Campaign goal or intent — e.g. 'Q3 product launch for Feature X targeting SMBs'"),
      title: z.string().optional().describe("Optional display title (auto-generated if omitted)"),
      brandId: brandOpt,
    },
    async ({ prompt, title, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { prompt };
      if (title !== undefined) body.title = title;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Get a storyline ─────────────────────────────────────────────────────────
  server.tool(
    "storyline_get",
    [
      "Fetch a single storyline by ID with its full state (brief, strategy, line items, status).",
      "Returns full detail by default. Use detail=\"medium\" for a compact summary or detail=\"short\" for {id,title,status}.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ storylineId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}`);
      if (detail === "full") {
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {} as Record<string, unknown>;
      const storyline = (raw.storyline != null && typeof raw.storyline === "object")
        ? (raw.storyline as Record<string, unknown>)
        : raw;
      const result = project(detail, storyline, storylineProj);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  // ── Update a storyline ──────────────────────────────────────────────────────
  server.tool(
    "storyline_update",
    [
      "Update metadata on a storyline: title, live status, or start/end/launch dates.",
      "Pass at least one field to change.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      title: z.string().optional().describe("New display title"),
      isLive: z.boolean().optional().describe("Whether the storyline is currently live/active"),
      storylineStartDate: z.string().datetime().optional().describe("ISO 8601 start date for the storyline"),
      storylineEndDate: z.string().datetime().optional().describe("ISO 8601 end date for the storyline"),
      launchDate: z.string().datetime().nullable().optional().describe("ISO 8601 launch date, or null to clear it"),
      brandId: brandOpt,
    },
    async ({ storylineId, title, isLive, storylineStartDate, storylineEndDate, launchDate, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (isLive !== undefined) body.isLive = isLive;
      if (storylineStartDate !== undefined) body.storylineStartDate = storylineStartDate;
      if (storylineEndDate !== undefined) body.storylineEndDate = storylineEndDate;
      if (launchDate !== undefined) body.launchDate = launchDate;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Delete (archive) a storyline ────────────────────────────────────────────
  server.tool(
    "storyline_delete",
    [
      "Archive (soft-delete) a storyline. Pass confirm: true to proceed.",
      "Use storyline_restore to reverse this.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID to archive"),
      confirm: z.literal(true).describe("Must be true to confirm archiving"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Restore a storyline ─────────────────────────────────────────────────────
  server.tool(
    "storyline_restore",
    "Restore an archived storyline back to active state.",
    {
      storylineId: z.string().describe("Storyline ID to restore"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/restore`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Clarify (intake) ────────────────────────────────────────────────────────
  server.tool(
    "storyline_clarify",
    [
      "Run the intake/clarification step for a storyline.",
      "The API returns follow-up questions or a readiness signal; call iteratively until the system has enough context.",
      "After clarification is complete, call storyline_generate_brief.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      userMessage: z.string().optional().describe("User's response to the last clarifying question (omit for the first call)"),
      brandId: brandOpt,
    },
    async ({ storylineId, userMessage, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (userMessage !== undefined) body.userMessage = userMessage;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/clarify`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Generate brief (async) ──────────────────────────────────────────────────
  server.tool(
    "storyline_generate_brief",
    (() => {
      const eta = etaFor("storyline_generate_brief");
      return [
        "Async. Generate the marketing brief for a storyline (positioning, key messages, audience, timing, tone notes).",
        "Returns { operationId, status } — poll get_job with the operationId until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
        "After completion, review the brief with storyline_get, then call storyline_confirm_brief to advance to strategy.",
      ].join(" ");
    })(),
    {
      storylineId: z.string().describe("Storyline ID"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/brief/generate`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Set brief (manual PUT) ──────────────────────────────────────────────────
  server.tool(
    "storyline_set_brief",
    [
      "Manually set (replace) the full brief for a storyline.",
      "Use to provide a human-authored brief or to push back an edited version retrieved via storyline_get.",
      "Pass the complete brief object and the current expectedVersion (use 0 when setting from scratch).",
      "After setting, call storyline_confirm_brief to advance to strategy generation.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      brief: z.object({
        positioning: z.string().describe("Brand positioning statement for this campaign"),
        audience: z.array(z.string()).describe("Target audience segments"),
        keyMessages: z.array(z.string()).describe("Core messages the campaign should communicate"),
        timing: z.object({
          startDate: z.string().describe("Campaign start date (ISO 8601 date string)"),
          endDate: z.string().describe("Campaign end date (ISO 8601 date string)"),
          launchDate: z.string().optional().describe("Optional launch date (ISO 8601 date string)"),
        }).describe("Campaign timing window"),
        proofPoints: z.array(z.string()).describe("Evidence or credibility points supporting the campaign"),
        dos: z.array(z.string()).describe("Tone and style guidelines — things to do"),
        donts: z.array(z.string()).describe("Tone and style guidelines — things to avoid"),
        toneNotes: z.string().describe("Overall tone of voice guidance for this campaign"),
        links: z.array(z.object({
          label: z.string().describe("Human-readable label for the link"),
          url: z.string().describe("URL"),
        })).describe("Reference links (product pages, press, assets) relevant to the campaign"),
      }).describe("Full brief object — replaces the entire current brief"),
      expectedVersion: z.number().int().min(0).describe("Optimistic-concurrency version from the current brief (pass 0 when setting from scratch)"),
      brandId: brandOpt,
    },
    async ({ storylineId, brief, expectedVersion, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.put<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/brief`, { brief, expectedVersion });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── AI-edit brief ───────────────────────────────────────────────────────────
  server.tool(
    "storyline_edit_brief",
    [
      "Apply an AI-driven edit to the current brief using a natural-language instruction.",
      "Examples: 'Make the tone more casual', 'Add a proof point about our 99% uptime SLA'.",
      "Optionally pass expectedVersion for optimistic concurrency.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      instruction: z.string().min(1).describe("Natural-language edit instruction"),
      expectedVersion: z.number().int().min(0).optional().describe("Optimistic-concurrency version (omit to skip version check)"),
      brandId: brandOpt,
    },
    async ({ storylineId, instruction, expectedVersion, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { instruction };
      if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/brief/ai-edit`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Confirm brief ───────────────────────────────────────────────────────────
  server.tool(
    "storyline_confirm_brief",
    [
      "Confirm (lock) the brief for a storyline, advancing it to the strategy phase.",
      "After confirmation, call storyline_generate_strategy.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/brief/confirm`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Get strategy ────────────────────────────────────────────────────────────
  server.tool(
    "storyline_get_strategy",
    [
      "Fetch the strategy and line items for a storyline.",
      "Returns full detail by default (raw strategy + all line items). Use detail=\"medium\" for a compact summary or detail=\"short\" for {id,status} + line-item count.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      detail: detailParam("full"),
      brandId: brandOpt,
    },
    async ({ storylineId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/strategy`);
      if (detail === "full") {
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      }
      const raw = data != null && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const lineItems = Array.isArray(raw.lineItems)
        ? (raw.lineItems as unknown[]).filter((li): li is Record<string, unknown> => !!li && typeof li === "object")
        : [];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            detail,
            lineItemCount: lineItems.length,
            lineItems: projectList(detail, lineItems, lineItemProj),
          }),
        }],
      };
    }
  );

  // ── Generate strategy (async) ───────────────────────────────────────────────
  server.tool(
    "storyline_generate_strategy",
    (() => {
      const eta = etaFor("storyline_generate_strategy");
      return [
        "Async. Generate the strategy and line-items for a storyline based on its confirmed brief.",
        "Returns { operationId, status } — poll get_job with the operationId until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
        "After completion, review with storyline_get_strategy, then optionally edit with storyline_edit_strategy or add/remove line items.",
      ].join(" ");
    })(),
    {
      storylineId: z.string().describe("Storyline ID"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/strategy/generate`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── AI-edit strategy ────────────────────────────────────────────────────────
  server.tool(
    "storyline_edit_strategy",
    [
      "Apply an AI-driven edit to the current strategy using a natural-language instruction.",
      "Examples: 'Add a LinkedIn video post for launch week', 'Remove the influencer outreach line items'.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      instruction: z.string().min(1).describe("Natural-language instruction for editing the strategy and/or line items"),
      brandId: brandOpt,
    },
    async ({ storylineId, instruction, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/strategy/ai-edit`, { instruction });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Estimate credits (read-only dry-run) ────────────────────────────────────
  server.tool(
    "storyline_estimate",
    [
      "Read-only dry-run. Estimate the credits required to execute the storyline without actually running it.",
      "Use before storyline_execute to surface the cost to the user for approval.",
      "Returns { estimatedCredits, lineItemBreakdown } or similar.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/estimate`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Add a line item ─────────────────────────────────────────────────────────
  server.tool(
    "storyline_add_line_item",
    [
      "Add a new line item (deliverable) to a storyline's strategy.",
      "Specify the channel, type, title, description, and a config map (pass {} if no extra config).",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      channel: z.string().min(1).describe("Publishing channel — e.g. 'linkedin', 'twitter', 'blog', 'email'"),
      type: z.string().min(1).describe("Content type — e.g. 'post', 'article', 'newsletter', 'video'"),
      title: z.string().min(1).describe("Line-item headline / title"),
      description: z.string().min(1).describe("What this piece of content should achieve or cover"),
      targetDate: z.string().optional().describe("Target publish date (ISO 8601)"),
      automatable: z.boolean().optional().describe("Whether PostKing can auto-generate this item (defaults to server-side logic)"),
      config: z.record(z.string(), z.unknown()).describe("Channel/type-specific configuration — pass {} if none"),
      brandId: brandOpt,
    },
    async ({ storylineId, channel, type, title, description, targetDate, automatable, config, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = { channel, type, title, description, config };
      if (targetDate !== undefined) body.targetDate = targetDate;
      if (automatable !== undefined) body.automatable = automatable;
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/line-items`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Update a line item ──────────────────────────────────────────────────────
  server.tool(
    "storyline_update_line_item",
    [
      "Update a line item on a storyline — select/deselect, retitle, change description, targetDate, or config.",
      "Pass only the fields to change.",
    ].join(" "),
    {
      storylineId: z.string().describe("Storyline ID"),
      itemId: z.string().describe("Line item ID from storyline_get_strategy"),
      selected: z.boolean().optional().describe("Include (true) or exclude (false) this line item from execution"),
      title: z.string().optional().describe("New title for the line item"),
      description: z.string().optional().describe("New description for the line item"),
      targetDate: z.string().optional().describe("New target publish date (ISO 8601)"),
      config: z.record(z.string(), z.unknown()).optional().describe("Replacement channel/type-specific configuration"),
      brandId: brandOpt,
    },
    async ({ storylineId, itemId, selected, title, description, targetDate, config, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (selected !== undefined) body.selected = selected;
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (targetDate !== undefined) body.targetDate = targetDate;
      if (config !== undefined) body.config = config;
      const data = await api.patch<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/line-items/${itemId}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Delete a line item ──────────────────────────────────────────────────────
  server.tool(
    "storyline_delete_line_item",
    "Permanently remove a line item from a storyline's strategy. Pass confirm: true to proceed.",
    {
      storylineId: z.string().describe("Storyline ID"),
      itemId: z.string().describe("Line item ID to delete"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
      brandId: brandOpt,
    },
    async ({ storylineId, itemId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.delete<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/line-items/${itemId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Regenerate a line item (async) ──────────────────────────────────────────
  server.tool(
    "storyline_regenerate_line_item",
    (() => {
      const eta = etaFor("storyline_regenerate_line_item");
      return [
        "Async. Re-generate a single line item's content draft.",
        "Returns { operationId, status } — poll get_job with the operationId until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
      ].join(" ");
    })(),
    {
      storylineId: z.string().describe("Storyline ID"),
      itemId: z.string().describe("Line item ID to regenerate"),
      brandId: brandOpt,
    },
    async ({ storylineId, itemId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/line-items/${itemId}/regenerate`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  // ── Execute storyline (async) ───────────────────────────────────────────────
  server.tool(
    "storyline_execute",
    (() => {
      const eta = etaFor("storyline_execute");
      return [
        "Async. Execute a storyline — generates content drafts for all selected line items.",
        "Returns { operationId, status } — poll get_job with the operationId until state=completed.",
        ...(eta ? [`Typically takes ${eta}.`] : []),
        "Call storyline_estimate first to surface the credit cost before execution.",
      ].join(" ");
    })(),
    {
      storylineId: z.string().describe("Storyline ID to execute"),
      brandId: brandOpt,
    },
    async ({ storylineId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<unknown>(`/api/agent/v1/brands/${id}/storylines/${storylineId}/execute`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
