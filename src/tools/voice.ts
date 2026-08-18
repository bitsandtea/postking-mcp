import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";
import { languageParam } from "../languages.js";

export function registerVoiceTools(server: McpServer) {
  server.tool(
    "list_voices",
    "List all available voice profiles with their IDs. Lists default short; pass detail=medium/full for more fields.",
    { detail: detailParam("short") },
    async ({ detail }) => {
      // Fire warmup in background so voices are ready for immediate use
      api.post("/api/voice-profiles/warm-up").catch(() => {});
      const data = await api.get<unknown[]>("/api/voice-profiles?slim=true");
      const raw = Array.isArray(data) ? data : [];
      const proj: Projector<unknown> = {
        short: (v) => ({ id: (v as any).id, name: (v as any).name }),
        medium: (v) => {
          const vr = v as Record<string, unknown>;
          return { id: vr.id, name: vr.name, description: vr.description, language: vr.language, category: vr.category };
        },
      };
      const text = JSON.stringify({ count: raw.length, detail, voices: projectList(detail, raw, proj) });
      return { content: [{ type: "text" as const, text }] };
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
      language: languageParam("Rewrites into this language; omit to keep the brand's configured content language."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ profileId, text, platform, language, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/rewrite`, {
        brandId: id,
        voiceProfileId: profileId,
        text,
        platform,
        language,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
