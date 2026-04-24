import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const DayMediumConfig = z.object({
  medium: z.string().describe("Platform medium: x/twitter | linkedin | instagram | facebook | threads | blog"),
  postsPerDay: z.number().int().min(1).max(5),
  voiceProfileId: z.string().optional().nullable(),
});

const DayConfig = z.object({
  dayOfWeek: z.number().int().min(0).max(6).describe("0=Sunday … 6=Saturday"),
  mediums: z.array(DayMediumConfig),
});

export function registerWeeklyScheduleTools(server: McpServer) {
  // ── Get weekly schedule ───────────────────────────────────────────────────
  server.tool(
    "get_weekly_schedule",
    [
      "Retrieve the current weekly content schedule for the active brand.",
      "Returns enabled status, lead time, timezone, and per-day platform configs.",
      "If no schedule is configured yet, returns suggested defaults.",
    ].join(" "),
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(
        `/api/agent/v1/brands/${id}/weekly-schedule`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Set / upsert weekly schedule ──────────────────────────────────────────
  server.tool(
    "set_weekly_schedule",
    [
      "Create or replace the weekly content schedule for the active brand.",
      "dayConfigs: array of { dayOfWeek (0=Sun…6=Sat), mediums: [{ medium, postsPerDay }] }.",
      "Mediums: x/twitter | linkedin | instagram | facebook | threads | blog.",
      "After setting, call enable_weekly_schedule to activate it.",
    ].join(" "),
    {
      enabled: z.boolean().optional().default(true).describe("Whether the schedule is active"),
      leadTimeDays: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .default(3)
        .describe("How many days ahead to generate content (1–7)"),
      timezone: z
        .string()
        .optional()
        .default("America/New_York")
        .describe("Timezone for scheduling, e.g. 'Europe/London'"),
      voiceProfileId: z.string().optional().nullable().describe("Default voice profile ID (optional)"),
      dayConfigs: z
        .array(DayConfig)
        .describe("Array of day configs. Omit a day to have no posts that day."),
      brandId: brandOpt,
    },
    async ({ enabled, leadTimeDays, timezone, voiceProfileId, dayConfigs, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.put<unknown>(
        `/api/agent/v1/brands/${id}/weekly-schedule`,
        { enabled, leadTimeDays, timezone, voiceProfileId, dayConfigs }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Enable schedule ───────────────────────────────────────────────────────
  server.tool(
    "enable_weekly_schedule",
    "Enable the weekly content schedule without changing its configuration. The schedule must already be created with set_weekly_schedule.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/weekly-schedule`,
        { enabled: true }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Disable schedule ──────────────────────────────────────────────────────
  server.tool(
    "disable_weekly_schedule",
    "Pause the weekly content schedule without deleting it. Re-enable later with enable_weekly_schedule.",
    { brandId: brandOpt },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<unknown>(
        `/api/agent/v1/brands/${id}/weekly-schedule`,
        { enabled: false }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Delete schedule ───────────────────────────────────────────────────────
  server.tool(
    "delete_weekly_schedule",
    "Permanently remove the weekly schedule for the active brand. Pass confirm: true to proceed.",
    {
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
      brandId: brandOpt,
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/weekly-schedule`);
      return {
        content: [{ type: "text" as const, text: "Weekly schedule deleted." }],
      };
    }
  );

  // ── Run schedule for a specific day ──────────────────────────────────────
  server.tool(
    "run_weekly_schedule_day",
    [
      "Trigger the smart-week content generation engine for a specific date.",
      "This immediately queues posts for that day's schedule configuration.",
      "Use YYYY-MM-DD format for the date. Returns postsCreated count.",
    ].join(" "),
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format").describe("Date to run, e.g. '2026-05-01'"),
      brandId: brandOpt,
    },
    async ({ date, brandId }) => {
      const id = requireBrandId(brandId);
      const targetDate = new Date(date).toISOString();
      const data = await api.post<any>(
        `/api/agent/v1/brands/${id}/posts/smart-week`,
        { targetDate }
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
