import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { languageParam } from "../languages.js";

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
      language: languageParam("Rewrites into this language; omit to keep the brand's configured content language."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ text, voice, platform, language, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/rewrite`, {
        brandId: id,
        text,
        voiceProfileId: voice,
        platform,
        language,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "humanize_text",
    "De-slop pass: replaces stock LLM phrasing — filler, hedges, canned transitions — with plainer, more specific prose, optionally tuned to a platform. A writing-quality tool: it does not change the fact that the text was AI-generated and must not be used to conceal AI authorship where disclosure is required.",
    {
      text: z.string().describe("Text to humanize"),
      platform: z
        .string()
        .optional()
        .describe("Platform context: x | linkedin | instagram | threads | facebook"),
      language: languageParam("Which language the text is treated as (and rewritten in); omit to use the brand's configured content language."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ text, platform, language, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post(`/api/agent/v1/tools/humanize`, { brandId: id, text, platform, language });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "check_ai_content",
    "Diagnostic: scores how generic/templated a piece of text reads and returns an analysis of which passages feel machine-written. Use it to find weak writing for a human to revise — not as a target to optimise against by re-running humanize_text until the score drops.",
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
