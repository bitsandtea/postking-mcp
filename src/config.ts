import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadStoredToken } from "./auth.js";

const DEFAULT_API_URL = "https://try.postking.app";

function resolveApiUrl(): string {
  const envUrl = process.env.POSTKING_API_URL;
  if (envUrl) return envUrl;

  if (process.env.NODE_ENV !== "production") {
    process.stderr.write(
      "[postking-mcp] WARNING: POSTKING_API_URL is not set. " +
        "Set it via --env POSTKING_API_URL=https://your-server in your MCP client config.\n" +
        `[postking-mcp] Falling back to ${DEFAULT_API_URL} — this is the PostKing production server.\n`
    );
  }

  return DEFAULT_API_URL;
}

export const config = {
  apiUrl: resolveApiUrl(),
  pollIntervalMs: 3000,
  pollTimeoutMs: 120_000,
} as const;

/**
 * Per-request token storage. The HTTP transport wraps `handleRequest` with
 * `runWithToken(token, fn)` so every tool call made inside resolves `token`
 * from AsyncLocalStorage — never from `process.env`. stdio path sets no token
 * and falls back to env / stored credential.
 */
const tokenStore = new AsyncLocalStorage<string | null>();

/** Per-session default token, bound at `createServer(token)` time. */
const serverTokens = new WeakMap<McpServer, string | null>();

export function setSessionToken(server: McpServer, token: string | null): void {
  serverTokens.set(server, token);
}

export function getSessionToken(server: McpServer): string | null {
  return serverTokens.get(server) ?? null;
}

export function runWithToken<T>(token: string | null, fn: () => Promise<T> | T): Promise<T> | T {
  return tokenStore.run(token, fn);
}

/**
 * Token resolution order:
 *   1. Per-request token in AsyncLocalStorage (HTTP transport).
 *   2. POSTKING_API_TOKEN env var (stdio / local dev).
 *   3. Stored credential file (stdio only — legacy behavior).
 */
export function getToken(): string | null {
  const req = tokenStore.getStore();
  if (req) return req;
  if (process.env.POSTKING_API_TOKEN) return process.env.POSTKING_API_TOKEN;
  return loadStoredToken();
}

export function requireToken(): string {
  const token = getToken();
  if (!token) {
    throw new Error(
      "Not logged in. Call the login_start tool to authenticate with PostKing."
    );
  }
  return token;
}
