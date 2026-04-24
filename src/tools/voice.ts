import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

export function registerVoiceTools(server: McpServer) {
  server.tool(
    "list_voices",
    "List all available voice profiles with their IDs.",
    {},
    async () => {
      // Fire warmup in background so voices are ready for immediate use
      api.post("/api/voice-profiles/warm-up").catch(() => {});
      const data = await api.get<unknown[]>("/api/voice-profiles?slim=true");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "rewrite_with_voice",
    "Rewrite text using a specific voice profile.",
    {
      profileId: z.string().describe("Voice profile ID"),
      text: z.string().describe("Text to rewrite"),
      platform: z
        .string()
        .optional()
        .describe("Platform context: x | linkedin | instagram | threads | facebook"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ profileId, text, platform, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/rewrite`, {
        brandId: id,
        voiceProfileId: profileId,
        text,
        platform,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
