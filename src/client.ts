import { config, oauthConfig, getTokenWithSource } from "./config.js";
import { deleteToken } from "./auth.js";
import { log } from "./log.js";

export interface AgentCreditPack {
  sku: string;
  priceUsd: number;
  credits: number;
}

export interface AgentErrorEnvelope {
  code?: string;
  message?: string;
  docsUrl?: string;
  retryable?: boolean;
  checkoutUrl?: string;
  packs?: AgentCreditPack[];
  topupEndpoint?: string;
  subscribeEndpoint?: string;
}

/**
 * Rich API error that preserves the full agent error envelope returned by
 * `/api/agent/v1/*` (see docs/43-agentic/02-imp-plan.md §0.1). Mirrors the
 * shape used by `postking-cli/src/client.ts`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly docsUrl?: string;
  readonly retryable?: boolean;
  readonly checkoutUrl?: string;
  readonly packs?: AgentCreditPack[];
  readonly topupEndpoint?: string;
  readonly subscribeEndpoint?: string;

  constructor(status: number, message: string, envelope?: AgentErrorEnvelope) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope?.code;
    this.docsUrl = envelope?.docsUrl;
    this.retryable = envelope?.retryable;
    this.checkoutUrl = envelope?.checkoutUrl;
    this.packs = envelope?.packs;
    this.topupEndpoint = envelope?.topupEndpoint;
    this.subscribeEndpoint = envelope?.subscribeEndpoint;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const tokenResult = getTokenWithSource();
  if (!tokenResult) {
    throw new Error(
      "Not logged in. Call the login_start tool to authenticate with PostKing."
    );
  }
  const { token, source } = tokenResult;
  const url = `${config.apiUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (oauthConfig.internalSecret) {
    headers["x-internal-secret"] = oauthConfig.internalSecret;
  }

  const start = Date.now();
  log("api", "→ " + method + " " + path, { source });

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    const ms = Date.now() - start;
    const cause = err instanceof Error
      ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
      : String(err);
    log("api", "✗ " + method + " " + path + " network error (" + ms + "ms)", { error: cause });
    throw new Error(`Cannot reach PostKing at ${url}: ${cause}`);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let envelope: AgentErrorEnvelope | undefined;
    try {
      const json = (await res.json()) as
        | { error?: AgentErrorEnvelope | string; message?: string }
        | undefined;
      if (json && typeof json.error === "object" && json.error !== null) {
        envelope = json.error;
        message = envelope.message ?? message;
      } else if (typeof json?.error === "string") {
        message = json.error;
      } else if (typeof json?.message === "string") {
        message = json.message;
      }
    } catch {
      // ignore — non-JSON body
    }

    const ms = Date.now() - start;
    log("api", "✗ " + method + " " + path + " " + res.status + " (" + ms + "ms)", { code: envelope?.code, message });

    if (res.status === 401) {
      const isInvalidKey =
        envelope?.code === "UNAUTHORIZED" &&
        /invalid|revoked/i.test(envelope.message ?? "");

      if (source === "file") {
        if (isInvalidKey) {
          deleteToken();
          throw new ApiError(
            401,
            "Your PostKing session was revoked or expired. Call the login_start tool to sign in again.",
            envelope
          );
        }
        throw new ApiError(
          401,
          `401 Unauthorized on ${method} ${path}` +
            (envelope?.code ? ` [${envelope.code}]` : "") +
            (envelope?.message ? `: ${envelope.message}` : "") +
            " — your saved credential was NOT cleared (this may be a per-route issue, not a bad key).",
          envelope
        );
      }
      throw new ApiError(
        401,
        envelope?.message ??
          (source === "env"
            ? "Invalid POSTKING_API_TOKEN. Check your environment variable."
            : "Not authenticated."),
        envelope
      );
    }
    if (res.status === 402) {
      if (envelope?.code === "INSUFFICIENT_CREDITS") {
        let richMessage: string;
        if (envelope.packs && envelope.packs.length > 0) {
          const packLines = envelope.packs
            .map((p) => `  • ${p.sku}: $${p.priceUsd} → ${p.credits} credits`)
            .join("\n");
          richMessage = [
            "Out of credits — credits refill with subscription or can be topped up via billing_topup.",
            "",
            "Available credit packs:",
            packLines,
            "",
            "AGENT INSTRUCTION: Present these packs to the USER and ask which one they want to purchase.",
            "Do NOT choose a pack on the user's behalf.",
            "Only AFTER the user explicitly picks a pack, call billing_topup with that packSku to get a Stripe checkout link.",
            "Hand the checkout link to the user — they must complete payment in their browser.",
            "Alternatively, show subscription options via billing_list_tiers / billing_subscribe.",
          ].join("\n");
        } else {
          richMessage = [
            "Out of credits — credits refill with subscription or can be topped up via billing_topup.",
            "",
            "AGENT INSTRUCTION: Call billing_list_packs to retrieve available credit packs,",
            "then present them to the USER and ask which one they want to purchase.",
            "Do NOT choose a pack on the user's behalf.",
            "Only AFTER the user explicitly picks a pack, call billing_topup with that packSku to get a Stripe checkout link.",
            "Alternatively, show subscription options via billing_list_tiers / billing_subscribe.",
          ].join("\n");
        }
        throw new ApiError(402, richMessage, envelope);
      }
      if (
        envelope?.code === "TRIAL_EXPIRED" ||
        envelope?.code === "SUBSCRIPTION_REQUIRED"
      ) {
        const richMessage = envelope.checkoutUrl
          ? [
              message,
              "",
              "AGENT INSTRUCTION: Share this upgrade link with the user so they can complete payment in their browser:",
              envelope.checkoutUrl,
            ].join("\n")
          : message;
        throw new ApiError(402, richMessage, envelope);
      }
      throw new ApiError(402, `Insufficient credits: ${message}`, envelope);
    }
    if (res.status === 403) {
      throw new ApiError(403, `Access denied: ${message}`, envelope);
    }
    if (res.status === 404) {
      throw new ApiError(404, `Not found: ${message}`, envelope);
    }
    throw new ApiError(res.status, message, envelope);
  }

  const ms = Date.now() - start;
  log("api", "← " + method + " " + path + " " + res.status + " (" + ms + "ms)");

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
