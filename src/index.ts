#!/usr/bin/env node
/**
 * Entrypoint. Picks transport based on env:
 *   POSTKING_MCP_TRANSPORT=stdio (default) | http
 *   POSTKING_MCP_PORT=3333 (when transport=http)
 *
 * For stdio: bit-identical to the pre-refactor behavior so existing users
 * (Claude Desktop, Cursor, etc.) are unaffected.
 */
import { runStdio } from "./transports/stdio.js";
import { runHttp } from "./transports/http.js";

async function main() {
  const mode = (process.env.POSTKING_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (mode === "http") {
    const port = Number(process.env.POSTKING_MCP_PORT ?? process.env.PORT ?? 3333);
    await runHttp({ port });
    return;
  }
  await runStdio();
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
