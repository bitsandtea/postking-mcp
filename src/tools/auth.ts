import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, getToken, getSessionId } from "../config.js";
import { saveToken, deleteToken } from "../auth.js";
import { api } from "../client.js";

// Per-session state for the two-step device flow.
// Keyed by session ID so concurrent HTTP sessions don't interfere with each other.
interface PendingFlow {
  deviceCode: string;
  interval: number;
  expiresAt: number;
}

const pendingFlows = new Map<string, PendingFlow>();

/** Resolve the session key — falls back to "stdio" for the stdio transport. */
function sessionKey(): string {
  return getSessionId() ?? "stdio";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

async function fetchJson<T>(path: string, body?: unknown): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: body !== undefined ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    const cause = err instanceof Error
      ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
      : String(err);
    throw new Error(`Cannot reach PostKing at ${url}: ${cause}`);
  }
  if (!res.ok) {
    throw new Error(`PostKing API error ${res.status} at ${url}`);
  }
  return res.json() as Promise<T>;
}

export function registerAuthTools(server: McpServer) {
  // ── login_start ───────────────────────────────────────────────────────────
  server.tool(
    "login_start",
    [
      "Start the PostKing login flow. Returns a URL and short code for the user to visit in their browser.",
      "IMPORTANT: Immediately after this tool returns, show the URL + code to the user and then call `login_complete` — it will wait (polling in the background) until the user approves the request in their browser, so there is no need to ask the user to tell you when they are done.",
    ].join(" "),
    {},
    async () => {
      const existing = getToken();
      if (existing) {
        try {
          const me = await api.get<{ email?: string }>("/api/agent/v1/me");
          const asEmail = me.email ? ` as ${me.email}` : "";
          return {
            content: [{
              type: "text" as const,
              text: `Already logged in${asEmail}. Call logout first if you want to switch accounts.`,
            }],
          };
        } catch {
          // Token is stale (401 handler in client.ts already cleared it if it came
          // from the credential file) or network/5xx — fall through to fresh login.
        }
      }

      const data = await fetchJson<DeviceCodeResponse>("/api/agent/auth/device/code", {});

      if (!data.device_code) {
        throw new Error("Failed to start login: no device_code returned.");
      }

      pendingFlows.set(sessionKey(), {
        deviceCode: data.device_code,
        interval: Math.max(1, data.interval || 5),
        expiresAt: Date.now() + (data.expires_in || 600) * 1000,
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            "**Action required: authorize PostKing in your browser.**",
            "",
            "IMPORTANT: Show the user this exact URL — do not paraphrase or omit it:",
            data.verification_uri,
            "",
            `The user should open the above link. The page will auto-authorize using code ${data.user_code}.`,
            "",
            `I am now waiting for you to approve — no need to tell me when done. (Expires in ${Math.floor(data.expires_in / 60)} min)`,
          ].join("\n"),
        }],
      };
    }
  );

  // ── login_complete ────────────────────────────────────────────────────────
  server.tool(
    "login_complete",
    "Wait for the user to approve the PostKing login code in their browser and then save the token. Polls automatically; call this immediately after `login_start`.",
    {},
    async () => {
      const key = sessionKey();
      const pending = pendingFlows.get(key);
      if (!pending) {
        throw new Error("No login in progress. Call login_start first.");
      }

      const HARD_CAP_MS = 10 * 60 * 1000; // 10 minutes
      const started = Date.now();

      while (true) {
        if (Date.now() > pending.expiresAt || Date.now() - started > HARD_CAP_MS) {
          pendingFlows.delete(key);
          throw new Error("Login code expired. Call login_start to begin again.");
        }

        const tokenUrl = `${config.apiUrl}/api/agent/auth/device/token`;
        let tokenRes: Response;
        try {
          tokenRes = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: pending.deviceCode }),
          });
        } catch (err) {
          const cause = err instanceof Error
            ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
            : String(err);
          throw new Error(`Cannot reach PostKing at ${tokenUrl}: ${cause}`);
        }
        const data = await tokenRes.json() as TokenResponse;

        if (data.access_token) {
          pendingFlows.delete(key);
          const isRemote = process.env.POSTKING_MCP_TRANSPORT === "http";
          if (isRemote) {
            const MCP_REMOTE_URL = "https://mcp.postking.app/mcp";
            return {
              content: [{
                type: "text" as const,
                text: [
                  "**You're signed in. One last step — paste this key into your MCP client.**",
                  "",
                  `API key: \`${data.access_token}\``,
                  "",
                  "For Hermes, run on your machine:",
                  "",
                  "```bash",
                  "hermes mcp remove postking-remote 2>/dev/null || true",
                  `hermes mcp add postking-remote --url ${MCP_REMOTE_URL} --header "Authorization: Bearer ${data.access_token}"`,
                  "```",
                  "",
                  "After re-adding, all PostKing tools become available in this session.",
                ].join("\n"),
              }],
            };
          }
          saveToken(data.access_token);
          return {
            content: [{
              type: "text" as const,
              text: "Logged in successfully. Your credentials are saved — you won't need to log in again.",
            }],
          };
        }

        if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") {
          if (data.error === "expired_token") {
            pendingFlows.delete(key);
            throw new Error("Login code expired. Call login_start to begin again.");
          }
          throw new Error(`Login failed: ${data.error}`);
        }

        const waitSecs = data.error === "slow_down" ? pending.interval + 5 : pending.interval;
        await sleep(waitSecs * 1000);
      }
    }
  );

  // ── logout ────────────────────────────────────────────────────────────────
  server.tool(
    "logout",
    "Clear locally stored PostKing credentials.",
    {},
    async () => {
      deleteToken();
      return {
        content: [{
          type: "text" as const,
          text: "Logged out. Your local credentials have been removed.",
        }],
      };
    }
  );

  // ── whoami ────────────────────────────────────────────────────────────────
  server.tool(
    "whoami",
    "Return the profile of the currently authenticated PostKing user (email, plan, credit balance).",
    {},
    async () => {
      const data = await api.get<Record<string, unknown>>("/api/agent/v1/me");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
