import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadStoredToken } from "./auth.js";

const DEFAULT_API_URL = "https://try.postking.app";

function resolveApiUrl(): string {
  return process.env.POSTKING_API_URL || DEFAULT_API_URL;
}

export const config = {
  apiUrl: resolveApiUrl(),
  pollIntervalMs: 3000,
  pollTimeoutMs: 120_000,
  // Content generation (multi-variation + voice rewrite + Modal cold starts) can
  // take several minutes; poll longer before falling back to a "still running" message.
  generatePollTimeoutMs: 300_000,
} as const;

export const webUrl = process.env.POSTKING_WEB_URL || resolveApiUrl();

/**
 * OAuth Resource Server configuration.
 * All values can be overridden via environment variables.
 */
export const oauthConfig = {
  /** The MCP resource URI advertised to clients (RFC 9728). */
  resourceUri: process.env.POSTKING_RESOURCE_URI ?? "https://mcp.postking.app/mcp",
  /** The Authorization Server issuer URL. */
  asIssuer: process.env.POSTKING_AS_ISSUER ?? "https://try.postking.app",
  /** Shared secret for the internal introspection endpoint. */
  internalSecret: process.env.POSTKING_INTERNAL_SECRET ?? null,
} as const;

/**
 * Per-request token storage. The HTTP transport wraps `handleRequest` with
 * `runWithToken(token, fn)` so every tool call made inside resolves `token`
 * from AsyncLocalStorage — never from `process.env`. stdio path sets no token
 * and falls back to env / stored credential.
 */
const tokenStore = new AsyncLocalStorage<string | null>();

/**
 * Per-request session ID storage. Mirrors the token store lifecycle — bound
 * by the HTTP transport for every incoming request so tools can key per-session
 * state without process globals.
 */
const sessionStore = new AsyncLocalStorage<string | null>();

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

export function runWithSession<T>(sessionId: string | null, fn: () => Promise<T> | T): Promise<T> | T {
  return sessionStore.run(sessionId, fn);
}

export function getSessionId(): string | null {
  return sessionStore.getStore() ?? null;
}

/**
 * Token resolution order:
 *   1. Per-request token in AsyncLocalStorage (HTTP transport).
 *   2. POSTKING_API_TOKEN env var (stdio / local dev).
 *   3. Stored credential file (stdio only — legacy behavior).
 */
export type TokenSource = "als" | "env" | "file";

export function getTokenWithSource(): { token: string; source: TokenSource } | null {
  const req = tokenStore.getStore();
  if (req) return { token: req, source: "als" };
  if (process.env.POSTKING_API_TOKEN) return { token: process.env.POSTKING_API_TOKEN, source: "env" };
  const stored = loadStoredToken();
  if (stored) return { token: stored, source: "file" };
  return null;
}

export function getToken(): string | null {
  return getTokenWithSource()?.token ?? null;
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
