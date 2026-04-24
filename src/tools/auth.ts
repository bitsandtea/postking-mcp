import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, getToken } from "../config.js";
import { saveToken, deleteToken } from "../auth.js";
import { api } from "../client.js";

// Shared in-process state for the two-step device flow
let pendingDeviceCode: string | null = null;
let pendingInterval = 5;
let pendingExpiresAt = 0;

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
    const cause = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}` : String(err);
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
      // Already logged in?
      const existing = getToken();
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Already logged in. Call logout first if you want to switch accounts.",
            },
          ],
        };
      }

      const data = await fetchJson<DeviceCodeResponse>(
        "/api/agent/auth/device/code",
        {}
      );

      if (!data.device_code) {
        throw new Error("Failed to start login: no device_code returned.");
      }

      pendingDeviceCode = data.device_code;
      pendingInterval = Math.max(1, data.interval || 5);
      pendingExpiresAt = Date.now() + (data.expires_in || 600) * 1000;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "**PostKing Login**",
              "",
              `1. Visit: ${data.verification_uri}`,
              `2. Enter code: **${data.user_code}**`,
              "",
              "I will now wait for you to approve in the browser — no need to tell me when you're done.",
              `(Code expires in ${Math.floor(data.expires_in / 60)} minutes)`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  // ── login_complete ────────────────────────────────────────────────────────
  server.tool(
    "login_complete",
    "Wait for the user to approve the PostKing login code in their browser and then save the token. Polls automatically; call this immediately after `login_start`.",
    {},
    async () => {
      if (!pendingDeviceCode) {
        throw new Error("No login in progress. Call login_start first.");
      }

      // Poll until approved, expired, or a hard safety cap is reached.
      const HARD_CAP_MS = 10 * 60 * 1000; // 10 minutes
      const started = Date.now();

      while (true) {
        if (Date.now() > pendingExpiresAt || Date.now() - started > HARD_CAP_MS) {
          pendingDeviceCode = null;
          throw new Error("Login code expired. Call login_start to begin again.");
        }

        const data = await fetchJson<TokenResponse>(
          "/api/agent/auth/device/token",
          { device_code: pendingDeviceCode }
        );

        if (data.access_token) {
          saveToken(data.access_token);
          pendingDeviceCode = null;
          return {
            content: [
              {
                type: "text" as const,
                text: "Logged in successfully. Your credentials are saved — you won't need to log in again.",
              },
            ],
          };
        }

        if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") {
          if (data.error === "expired_token") {
            pendingDeviceCode = null;
            throw new Error("Login code expired. Call login_start to begin again.");
          }
          throw new Error(`Login failed: ${data.error}`);
        }

        const waitSecs = data.error === "slow_down" ? pendingInterval + 5 : pendingInterval;
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
        content: [
          {
            type: "text" as const,
            text: "Logged out. Your local credentials have been removed.",
          },
        ],
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
