/**
 * stdio transport — the classic `npx postking-mcp` flow.
 *
 * Behavior is bit-identical to the pre-refactor `src/index.ts` so existing
 * Claude Desktop / Cursor users are unaffected.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../server.js";

export async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log tool count on stderr so clients (Hermes, Claude Desktop) can verify parity.
  const toolCount = (server as any)._registeredTools
    ? Object.keys((server as any)._registeredTools).length
    : "unknown";
  process.stderr.write(`PostKing MCP server running on stdio (tools registered: ${toolCount})\n`);
}
