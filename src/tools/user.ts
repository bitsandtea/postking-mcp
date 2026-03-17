import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";

export function registerUserTools(server: McpServer) {
  server.tool(
    "get_credits",
    "Check your current PostKing credit balance.",
    {},
    async () => {
      const data = await api.get("/api/user/credits");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
