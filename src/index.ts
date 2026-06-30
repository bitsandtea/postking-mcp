#!/usr/bin/env node
/**
 * Entrypoint. Picks transport based on env:
 *   POSTKING_MCP_TRANSPORT=stdio (default) | http
 *   POSTKING_MCP_PORT=3333 (when transport=http)
 *
 * For stdio: bit-identical to the pre-refactor behavior so existing users
 * (Claude Desktop, Cursor, etc.) are unaffected.
 */
import "dotenv/config";

// Disable TLS verification for local HTTPS API URLs only (never for remote hosts).
{
  const rawUrl = process.env.POSTKING_API_URL;
  if (rawUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      // invalid URL — ignore; config.ts will surface the error later
    }
    if (
      parsed &&
      parsed.protocol === "https:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      process.stderr.write(
        `[warn] TLS verification disabled for local API URL: ${parsed.origin}\n`
      );
    }
  }
}

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
