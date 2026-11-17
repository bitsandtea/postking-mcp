import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, getToken, getTransport, getTokenWithSource, toPublicTokenSource } from "../config.js";
import { saveToken, deleteToken } from "../auth.js";
import { api } from "../client.js";
import {
  clearPendingLogin,
  decideReuse,
  DEVICE_CLIENT_NAME,
  deviceUserAgent,
  isReusablePendingLogin,
  loadPendingLogin,
  savePendingLogin,
  type PendingLogin,
} from "../pendingLogin.js";

const MCP_REMOTE_URL = "https://mcp.postking.app/mcp";

/** Guidance shown when a login/logout tool is called on the http (OAuth) transport. */
const REMOTE_AUTH_EXPLAINER = [
  "This connection authenticates via an OAuth bearer token supplied by your MCP client — there is no device-code flow to run here.",
  "",
  "Your MCP client should have completed OAuth (dynamic client registration + PKCE) before this session was created. If tool calls are failing with auth errors, the fix is on the client side — reconnect / re-authorize — not by calling login_start/login_complete/logout.",
  "",
  "To (re-)connect a remote client such as Hermes with a PostKing API key instead of interactive OAuth:",
  "",
  "```bash",
  "hermes mcp remove postking-remote 2>/dev/null || true",
  `hermes mcp add postking-remote --url ${MCP_REMOTE_URL} --header \"Authorization: Bearer <your-api-key>\"`,
  "```",
  "",
  "Get an API key by running login_start/login_complete on a stdio connection (e.g. Claude Desktop, Claude Code, or the CLI), or from the PostKing dashboard's API keys page.",
].join("\n");

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

const DEVICE_HEADERS = { "Content-Type": "application/json", "User-Agent": deviceUserAgent() };

async function fetchJson<T>(path: string, body?: unknown): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: body !== undefined ? "POST" : "GET",
      headers: DEVICE_HEADERS,
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

/** One poll of the token endpoint. Throws only when PostKing is unreachable. */
async function pollToken(deviceCode: string): Promise<TokenResponse> {
  const tokenUrl = `${config.apiUrl}/api/agent/auth/device/token`;
  let tokenRes: Response;
  try {
    tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: DEVICE_HEADERS,
      body: JSON.stringify({ device_code: deviceCode }),
    });
  } catch (err) {
    const cause = err instanceof Error
      ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
      : String(err);
    throw new Error(`Cannot reach PostKing at ${tokenUrl}: ${cause}`);
  }
  return (await tokenRes.json().catch(() => ({}))) as TokenResponse;
}

function loggedInText(): string {
  const envWarning = process.env.POSTKING_API_TOKEN
    ? "\n\nWARNING: the POSTKING_API_TOKEN environment variable is set and takes precedence over the file credential just saved — this login will NOT take effect until that environment variable is unset."
    : "";
  return "Logged in successfully. Your credentials are saved — you won't need to log in again." + envWarning;
}

function approvalPromptText(pending: PendingLogin, reused: boolean): string {
  const minutesLeft = Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 60000));
  return [
    "**Action required: approve PostKing in your browser.**",
    "",
    "IMPORTANT: Show the user this exact URL — do not paraphrase or omit it:",
    pending.verificationUri,
    "",
    `The user should open the above link and press Approve (code ${pending.userCode}). No PostKing account yet? The same page lets them create one and returns them to the approval.`,
    "",
    reused
      ? `This is the SAME link as before — it is still valid, no new one was created. Now call login_complete to wait for the approval. (Expires in ${minutesLeft} min)`
      : `Now call login_complete — it waits until the user approves, no need to ask them to confirm. (Expires in ${minutesLeft} min)`,
  ].join("\n");
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
      if (getTransport() === "http") {
        return { content: [{ type: "text" as const, text: REMOTE_AUTH_EXPLAINER }] };
      }

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

      // One login attempt = one device request: if a request from an earlier
      // login_start is still valid, redeem it (the user already approved) or
      // show the same link again instead of creating another one.
      const previous = loadPendingLogin();
      if (isReusablePendingLogin(previous, config.apiUrl)) {
        const answer = await pollToken(previous.deviceCode).catch(() => null);
        const decision = decideReuse(answer);
        if (decision === "logged_in" && answer?.access_token) {
          clearPendingLogin();
          saveToken(answer.access_token);
          return { content: [{ type: "text" as const, text: loggedInText() }] };
        }
        if (decision === "show_again") {
          return { content: [{ type: "text" as const, text: approvalPromptText(previous, true) }] };
        }
        clearPendingLogin();
      }

      const data = await fetchJson<DeviceCodeResponse>("/api/agent/auth/device/code", {
        client_name: DEVICE_CLIENT_NAME,
      });

      if (!data.device_code) {
        throw new Error("Failed to start login: no device_code returned.");
      }

      const pending: PendingLogin = {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        interval: Math.max(1, data.interval || 5),
        expiresAt: Date.now() + (data.expires_in || 600) * 1000,
        apiUrl: config.apiUrl,
      };
      savePendingLogin(pending);

      return { content: [{ type: "text" as const, text: approvalPromptText(pending, false) }] };
    }
  );

  // ── login_complete ────────────────────────────────────────────────────────
  server.tool(
    "login_complete",
    "Wait for the user to approve the PostKing login code in their browser and then save the token. Polls automatically; call this immediately after `login_start`.",
    {},
    async () => {
      if (getTransport() === "http") {
        return { content: [{ type: "text" as const, text: REMOTE_AUTH_EXPLAINER }] };
      }

      const pending = loadPendingLogin();
      if (!pending || pending.apiUrl !== config.apiUrl) {
        throw new Error("No login in progress. Call login_start first.");
      }

      const HARD_CAP_MS = 10 * 60 * 1000; // 10 minutes per call
      const started = Date.now();

      while (true) {
        if (Date.now() > pending.expiresAt) {
          clearPendingLogin();
          throw new Error("Login code expired. Call login_start to begin again.");
        }
        if (Date.now() - started > HARD_CAP_MS) {
          // Keep the request: the link stays valid, so waiting again (or
          // calling login_start, which re-shows the same link) resumes it.
          throw new Error(
            `Still waiting for approval at ${pending.verificationUri} — the link is still valid. Call login_complete again to keep waiting.`
          );
        }

        const data = await pollToken(pending.deviceCode);

        if (data.access_token) {
          clearPendingLogin();
          saveToken(data.access_token);
          return { content: [{ type: "text" as const, text: loggedInText() }] };
        }

        if (data.error !== "authorization_pending" && data.error !== "slow_down") {
          clearPendingLogin();
          if (data.error === "expired_token") {
            throw new Error("Login code expired. Call login_start to begin again.");
          }
          throw new Error(`Login failed: ${data.error ?? "unexpected response"}. Call login_start to begin again.`);
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
      if (getTransport() === "http") {
        return {
          content: [{
            type: "text" as const,
            text: [
              "This transport authenticates via an OAuth bearer token supplied per-connection by your MCP client — there is no local credential file to clear here.",
              "",
              "To fully log out, revoke access from your MCP client's connection settings or from the PostKing dashboard's connected apps page.",
            ].join("\n"),
          }],
        };
      }

      deleteToken();
      clearPendingLogin();
      const envWarning = process.env.POSTKING_API_TOKEN
        ? "\n\nWARNING: the POSTKING_API_TOKEN environment variable is still set and remains active as the credential source even though the file credential was removed."
        : "";
      return {
        content: [{
          type: "text" as const,
          text: "Logged out. Your local credentials have been removed." + envWarning,
        }],
      };
    }
  );

  // ── whoami ────────────────────────────────────────────────────────────────
  server.tool(
    "whoami",
    "Return the profile of the currently authenticated PostKing user (email, plan, credit balance, token source).",
    {},
    async () => {
      const tokenResult = getTokenWithSource();
      const data = await api.get<Record<string, unknown>>("/api/agent/v1/me");
      const tokenSource = tokenResult ? toPublicTokenSource(tokenResult.source) : null;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...data, tokenSource }, null, 2) }],
      };
    }
  );
}
