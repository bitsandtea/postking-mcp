import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";
import { config } from "../config.js";
import { detailParam, project, type Projector } from "../detail.js";

export function registerUserTools(server: McpServer) {
  server.tool(
    "get_credits",
    "Check your current PostKing credit balance and free-tier status.",
    { detail: detailParam("full") },
    async ({ detail }) => {
      const data = await api.get<{
        credits: number;
        isPaid: boolean;
        freeTierRemaining: number | null;
        freeTierUsed: number | null;
        freeTierCap: number;
      }>("/api/agent/v1/me");
      const proj: Projector<typeof data> = {
        short: (d) => ({ credits: d.credits, isPaid: d.isPaid }),
        medium: (d) => ({
          credits: d.credits,
          isPaid: d.isPaid,
          freeTierRemaining: d.freeTierRemaining,
          freeTierUsed: d.freeTierUsed,
          freeTierCap: d.freeTierCap,
        }),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(project(detail, data, proj)) }],
      };
    }
  );

  server.tool(
    "health",
    "Check PostKing API health. Returns service status and version. No authentication required.",
    {},
    async () => {
      const url = `${config.apiUrl}/api/agent/v1/health`;
      const res = await fetch(url);
      const data = await res.json();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
