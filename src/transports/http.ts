/**
 * Streamable HTTP transport (per the MCP spec) for hosted deployments.
 *
 * OAuth RS behavior (RFC 9728 + RFC 6750):
 *  - GET /.well-known/oauth-protected-resource   → resource metadata document
 *  - GET /.well-known/oauth-protected-resource/mcp → same document (alias)
 *  - POST /mcp with no / invalid bearer           → 401 + WWW-Authenticate
 *  - POST /mcp with valid bearer                  → introspect, then handle
 *
 * Every request binds the validated bearer and the MCP session ID into
 * AsyncLocalStorage so tools can read them without touching process.env.
 *
 * GET /.well-known/mcp/server-card.json → static tool listing so scanners
 * that can't complete the OAuth dance (e.g. Smithery) can still index the
 * server. Generated once by driving the real McpServer through an in-memory
 * client, so it can never drift from the actual registered tools.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../server.js";
import { runWithToken, runWithSession, oauthConfig } from "../config.js";
import { introspectToken } from "../oauth/introspect.js";
import { deleteSessionState } from "../state.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

let serverCardPromise: Promise<string> | undefined;

async function buildServerCard(): Promise<string> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "postking-mcp-server-card-generator", version: pkg.version });
  const server = createServer();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  return JSON.stringify({
    serverInfo: { name: "postking", version: pkg.version },
    authentication: { required: true, schemes: ["oauth2"] },
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    resources: [],
    prompts: [],
  });
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  token: string;
  sessionId: string;
}

const sessions = new Map<string, SessionEntry>();

function extractBearer(req: http.IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Derive the resource base URL (without /mcp suffix) for use in
 * WWW-Authenticate challenges and the well-known document.
 */
function resourceBaseUrl(): string {
  const uri = oauthConfig.resourceUri;
  return uri.endsWith("/mcp") ? uri.slice(0, -4) : uri;
}

function sendUnauthorized(res: http.ServerResponse): void {
  const base = resourceBaseUrl();
  res.writeHead(401, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  });
  res.end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }));
}

function sendResourceMetadata(res: http.ServerResponse): void {
  const body = JSON.stringify({
    resource: oauthConfig.resourceUri,
    authorization_servers: [oauthConfig.asIssuer],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
  });
  res.writeHead(200, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=3600",
  });
  res.end(body);
}

export interface HttpTransportOptions {
  port: number;
  healthPath?: string;
}

export async function runHttp(opts: HttpTransportOptions): Promise<http.Server> {
  const { port, healthPath = "/health" } = opts;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // ── Health check ────────────────────────────────────────────────────────
      if (url.pathname === healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          service: "postking-mcp",
          transport: "http",
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // ── Static server card (SEP-1649) for scanners that can't do OAuth ──────
      if (req.method === "GET" && url.pathname === "/.well-known/mcp/server-card.json") {
        if (!serverCardPromise) serverCardPromise = buildServerCard();
        try {
          const body = await serverCardPromise;
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=3600",
          });
          res.end(body);
        } catch (err) {
          serverCardPromise = undefined;
          throw err;
        }
        return;
      }

      // ── RFC 9728 — OAuth Protected Resource Metadata ────────────────────────
      if (
        req.method === "GET" &&
        (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname === "/.well-known/oauth-protected-resource/mcp")
      ) {
        sendResourceMetadata(res);
        return;
      }

      // ── CORS pre-flight for well-known routes ───────────────────────────────
      if (
        req.method === "OPTIONS" &&
        (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname === "/.well-known/oauth-protected-resource/mcp")
      ) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        });
        res.end();
        return;
      }

      // ── MCP endpoint ─────────────────────────────────────────────────────────
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      // CORS pre-flight for /mcp — browser-based clients send OPTIONS before POST.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, mcp-session-id",
        });
        res.end();
        return;
      }

      // Require a bearer token on the HTTP transport — no anonymous sessions.
      const token = extractBearer(req);
      if (!token) {
        sendUnauthorized(res);
        return;
      }

      // Validate the token via introspection (cached 45 s).
      try {
        await introspectToken(token);
      } catch (err) {
        const e = err as Error & { status?: number };
        if (!e.status || e.status === 401) {
          sendUnauthorized(res);
          return;
        }
        // 503 / 500 — introspection endpoint unavailable; surface as 503
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "service_unavailable", error_description: e.message }));
        return;
      }

      // ── Session management ───────────────────────────────────────────────────
      const sessionIdHeader = req.headers["mcp-session-id"];
      const incomingSessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;

      let entry: SessionEntry | undefined = incomingSessionId
        ? sessions.get(incomingSessionId)
        : undefined;

      if (!entry) {
        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
        });
        const server = createServer(token);
        await server.connect(transport);
        entry = { transport, server, token, sessionId: newSessionId };
        sessions.set(newSessionId, entry);
        transport.onclose = () => {
          sessions.delete(newSessionId);
          deleteSessionState(newSessionId);
        };
      }

      // Update the stored token to the current request's validated bearer.
      // Hermes rotates tokens on OAuth refresh; keeping the entry token current
      // ensures the forwarded Authorization header is never a revoked token.
      entry.token = token;

      const body = await readBody(req).catch(() => undefined);

      // Bind the validated bearer AND the session ID for the duration of this
      // request so all tool calls downstream can read them without process.env.
      const currentEntry = entry;
      await runWithToken(currentEntry.token, () =>
        runWithSession(currentEntry.sessionId, () =>
          currentEntry.transport.handleRequest(req, res, body)
        )
      );
    } catch (err) {
      const e = err as Error;
      process.stderr.write(`[http] error: ${e.message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: { code: "INTERNAL", message: e.message || "internal error" },
        }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  process.stderr.write(
    `PostKing MCP server running on http://0.0.0.0:${port} (health: ${healthPath})\n`
  );
  return httpServer;
}
