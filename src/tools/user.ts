import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";
import { config, getTokenWithSource, getTransport, toPublicTokenSource } from "../config.js";
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
    [
      "Check PostKing API health and local auth state. No authentication required —",
      "safe to call first thing in a session to see whether you're logged in and what to do next.",
    ].join(" "),
    {},
    async () => {
      const url = `${config.apiUrl}/api/agent/v1/health`;
      let serverHealth: unknown;
      try {
        const res = await fetch(url);
        serverHealth = await res.json();
      } catch (err) {
        serverHealth = { reachable: false, error: err instanceof Error ? err.message : String(err) };
      }

      const transport = getTransport();
      const tokenResult = getTokenWithSource();
      const loggedIn = tokenResult !== null;
      const tokenSource = tokenResult ? toPublicTokenSource(tokenResult.source) : null;

      let nextStep: string;
      if (!loggedIn) {
        nextStep =
          transport === "stdio"
            ? "Call the login_start tool to begin device-flow login."
            : "Not logged in. This transport authenticates via an OAuth bearer token supplied by your MCP client during connection setup (dynamic client registration + PKCE) — there is no in-session login step. If tool calls are failing with auth errors, reconnect / re-authorize this MCP connection in your client rather than calling login_start.";
      } else if (tokenSource === "env") {
        nextStep =
          "Logged in via the POSTKING_API_TOKEN environment variable. WARNING: this env var takes precedence over any file-based login — logout and login_start will have no effect while it is set.";
      } else {
        nextStep = `Logged in via ${tokenSource}.`;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ server: serverHealth, transport, loggedIn, tokenSource, nextStep }, null, 2),
        }],
      };
    }
  );
}
