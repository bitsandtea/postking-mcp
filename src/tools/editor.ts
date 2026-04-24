import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

export function registerEditorTools(server: McpServer) {
  server.tool(
    "rewrite_text",
    "Rewrite text using a voice profile or general writing rules.",
    {
      text: z.string().describe("Text to rewrite"),
      voice: z.string().optional().describe("Voice profile ID to apply"),
      platform: z
        .string()
        .optional()
        .describe("Platform context: x | linkedin | instagram | threads | facebook"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ text, voice, platform, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/rewrite`, {
        brandId: id,
        text,
        voiceProfileId: voice,
        platform,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "humanize_text",
    "Apply LLM rewrite and BERT replacements to reduce AI detection signals in text.",
    {
      text: z.string().describe("Text to humanize"),
      platform: z
        .string()
        .optional()
        .describe("Platform context: x | linkedin | instagram | threads | facebook"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ text, platform, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/humanize`, { brandId: id, text, platform });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "check_ai_content",
    "Check whether text is likely AI-generated. Returns a score and analysis.",
    {
      text: z.string().describe("Text to check"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ text, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/ai-check`, { brandId: id, text });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
