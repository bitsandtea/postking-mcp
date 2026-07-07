import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

interface PerplexitySearchResult {
  answer: string;
  sources: Array<{ title: string; url: string; description?: string }>;
  relatedPrompts: string[];
}

export function registerPerplexitySearchTools(server: McpServer) {
  // ── Live web search (Perplexity) ───────────────────────────────────────────
  server.tool(
    "web_search",
    [
      "Perform a live, real-time web search and get back a raw answer with sources — for questions like 'find me the top 10 places to share/index my MCP', 'what's the latest on X', or 'where can I find Y'.",
      "Distinct from search_web_images, which only returns images — this tool returns a synthesized text answer plus the sources it drew from (each with title, url, and optional description), and optionally related follow-up prompts.",
      "Results are returned as-is (unsummarized) — pass the answer and sources straight through to the user.",
    ].join(" "),
    {
      brandId: brandOpt,
      prompt: z.string().describe("The search query or question to answer via live web search, e.g. 'top 10 places to share/index my MCP'"),
    },
    async ({ brandId, prompt }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<{ answer?: string; sources?: Array<{ title: string; url: string; description?: string }>; relatedPrompts?: string[] }>(
        `/api/agent/v1/brands/${id}/perplexity-search`,
        { prompt }
      );
      const result: PerplexitySearchResult = {
        answer: data?.answer ?? "",
        sources: data?.sources ?? [],
        relatedPrompts: data?.relatedPrompts ?? [],
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}
