import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadStoredToken } from "./auth.js";

const DEFAULT_API_URL = "https://try.postking.app";

function resolveApiUrl(): string {
  return process.env.POSTKING_API_URL || DEFAULT_API_URL;
}

/** True when `u` points at localhost, a loopback address, or a private-network host. */
function isLocalHost(u: string): boolean {
  try {
    const { hostname } = new URL(u);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") {
      return true;
    }
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function parseGracePollMs(): number {
  const raw = process.env.POSTKING_GENERATE_GRACE_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

export const config = {
  apiUrl: resolveApiUrl(),
  pollIntervalMs: 3000,
  pollTimeoutMs: 120_000,
  // Content generation (multi-variation + voice rewrite + Modal cold starts) can
  // take several minutes; kept for reference / other callers but no longer used to
  // block generate_post — see generateGracePollMs below.
  generatePollTimeoutMs: 300_000,
  // generate_post only holds the MCP request open for this short grace window so fast
  // generations can return inline; anything slower falls back to a "generating" status
  // and the caller polls get_post. Keeps well under remote-gateway request timeouts.
  generateGracePollMs: parseGracePollMs(),
} as const;

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

/**
 * Per-request authenticated user ID storage (the introspected token's `sub`).
 * Bound by the HTTP transport alongside token/session so tools can key
 * per-user state (e.g. active brand) that survives session re-init after a
 * redeploy. Unset on stdio — there's no introspection there.
 */
const userIdStore = new AsyncLocalStorage<string | null>();

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

export function runWithUserId<T>(userId: string | null, fn: () => Promise<T> | T): Promise<T> | T {
  return userIdStore.run(userId, fn);
}

export function getUserId(): string | null {
  return userIdStore.getStore() ?? null;
}

/**
 * Token resolution order:
 *   1. Per-request token in AsyncLocalStorage (HTTP transport).
 *   2. POSTKING_API_TOKEN env var (stdio / local dev).
 *   3. Stored credential file (stdio only — legacy behavior).
 */
export type TokenSource = "als" | "env" | "file";

/** Public-facing token source names (as reported by `health` / `whoami`). */
export type PublicTokenSource = "oauth" | "env" | "file";

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

/** Maps the internal token source to the name used in user-facing tool output. */
export function toPublicTokenSource(source: TokenSource): PublicTokenSource {
  return source === "als" ? "oauth" : source;
}

/**
 * Which transport this process is running as. Set by the two bin entrypoints
 * (postking-mcp.ts → "stdio", postking-mcp-http.ts → "http") before the
 * server is created.
 */
export type Transport = "stdio" | "http";

export function getTransport(): Transport {
  return process.env.POSTKING_MCP_TRANSPORT === "http" ? "http" : "stdio";
}

/**
 * Resolves the public web URL used to build user-facing links (visual editor,
 * dashboard, generate session). On the HTTP (remote/hosted) transport this must
 * never resolve to a localhost/private address — a remote client can't reach it.
 * On stdio (local dev) a localhost value is expected and left as-is.
 */
function resolveWebUrl(): string {
  const resolved = process.env.POSTKING_WEB_URL || resolveApiUrl();
  if (getTransport() === "http" && isLocalHost(resolved)) {
    console.warn(
      `[postking-mcp] HTTP transport resolved a localhost web URL (${resolved}); falling back to ${DEFAULT_API_URL}. Set POSTKING_WEB_URL (or POSTKING_API_URL) to a public URL for hosted deployments.`
    );
    return DEFAULT_API_URL;
  }
  return resolved;
}

export const webUrl = resolveWebUrl();

/** Transport-aware guidance for "no token could be resolved at all". */
export function notLoggedInMessage(): string {
  return getTransport() === "http"
    ? "Not authenticated. This connection uses OAuth bearer authentication — your MCP client should complete its OAuth flow before making tool calls. Call the health tool for details, or reconnect the client."
    : "Not logged in. Call the login_start tool to authenticate with PostKing.";
}

export function requireToken(): string {
  const token = getToken();
  if (!token) {
    throw new Error(notLoggedInMessage());
  }
  return token;
}
