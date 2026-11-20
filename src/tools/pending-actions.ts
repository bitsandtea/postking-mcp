import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";

export function registerPendingActionTools(server: McpServer): void {
  server.tool(
    "get_pending_action",
    "Check a request waiting on the user: an email-confirmed delete (pendingActionId from a delete tool) or a brand access request (requestId from request_brand_access; executed = brands added). status is pending (owner has not clicked the email link yet), executed (deleted), failed (see failureMessage), expired (24h passed, nothing deleted) or cancelled.",
    {
      pendingActionId: z.string().describe("pendingActionId returned by a delete tool"),
    },
    async ({ pendingActionId }) => {
      const data = await api.get<unknown>(`/api/agent/v1/pending-actions/${encodeURIComponent(pendingActionId)}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
