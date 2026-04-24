/**
 * Streamable HTTP transport (per the MCP spec) for hosted deployments.
 *
 * Every request reads `Authorization: Bearer pk_live_*` from the inbound HTTP
 * headers and binds it to the current async context via `runWithToken`. That
 * keeps tokens scoped to a single request — no `process.env` mutation, no
 * cross-session leakage — while outbound `/api/agent/v1/*` calls pick the
 * token up through `config.getToken()`.
 *
 * Sessions are tracked in-memory (keyed by MCP session id). Horizontal scaling
 * is safe because each session's transport is sticky to a single process.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../server.js";
import { runWithToken } from "../config.js";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  token: string | null;
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

export interface HttpTransportOptions {
  port: number;
  healthPath?: string;
}

export async function runHttp(opts: HttpTransportOptions): Promise<http.Server> {
  if (process.env.FF_REMOTE_MCP_ENABLED !== "true") {
    process.stderr.write(
      "FF_REMOTE_MCP_ENABLED is not 'true' — refusing to start remote MCP HTTP transport.\n"
    );
    process.exit(1);
  }

  const { port, healthPath = "/health" } = opts;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname === healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            service: "postking-mcp",
            transport: "http",
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      // Bearer is optional — an anonymous session can still call the device-code
      // login tools (`login_start` / `login_complete`). Any tool that needs the
      // PostKing API will 401 naturally via the api client.
      const token = extractBearer(req);

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;

      let entry: SessionEntry | undefined = sessionId
        ? sessions.get(sessionId)
        : undefined;

      if (!entry) {
        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
        });
        // Each session owns its own closure-scoped token.
        const server = createServer(token ?? undefined);
        await server.connect(transport);
        entry = { transport, server, token };
        sessions.set(newSessionId, entry);
        transport.onclose = () => {
          sessions.delete(newSessionId);
        };
      }

      const body = await readBody(req).catch(() => undefined);
      // Bind the request-scoped token via AsyncLocalStorage for the duration
      // of this request so every outbound `api.*` call picks it up without
      // touching `process.env`.
      await runWithToken(entry.token, () =>
        entry!.transport.handleRequest(req, res, body)
      );
    } catch (err) {
      const e = err as Error;
      process.stderr.write(`[http] error: ${e.message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "INTERNAL", message: e.message || "internal error" },
          })
        );
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
