import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerBrandAccessTools(server: McpServer): void {
  server.tool(
    "list_brand_access",
    "List every brand the user owns or admins and whether THIS connection can reach it (accessible true/false). unrestricted:true means the connection already reaches all brands. list_brands only shows reachable ones, so use this to find brands to request.",
    {},
    async () => text(await api.get<unknown>("/api/agent/v1/brand-access"))
  );

  server.tool(
    "request_brand_access",
    "Ask for more brands on this connection. Returns a confirmUrl: show it to the user and tell them to open it (signed in) and press Confirm. Nothing changes until they do. Only brands the user owns or admins are eligible; ineligible lists the rest with a reason. After they confirm, call list_brands again (or get_pending_action with requestId: executed means done). Omit brandIds to request every eligible brand not yet granted. No link is returned when the connection is already unrestricted.",
    {
      brandIds: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Brand ids to add. Omit for all eligible brands this connection cannot see yet."),
    },
    async ({ brandIds }) => text(await api.post<unknown>("/api/agent/v1/brand-access/request", brandIds ? { brandIds } : {}))
  );
}
