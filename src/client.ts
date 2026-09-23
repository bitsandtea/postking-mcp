import { config, oauthConfig, getTokenWithSource, notLoggedInMessage } from "./config.js";
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
  /**
   * Machine-readable sub-reason for the error, e.g. "key_invalid" for a
   * revoked/expired/malformed API key on a 401. Optional because older
   * server versions don't emit it — callers should fall back to matching
   * on `message` when absent.
   */
  reason?: string;
  docsUrl?: string;
  retryable?: boolean;
  checkoutUrl?: string;
  packs?: AgentCreditPack[];
  topupEndpoint?: string;
  subscribeEndpoint?: string;
  /**
   * Free-form machine-readable payload attached to specific error codes, e.g.
   * `{ baseVersionId, currentVersionId }` on a `STALE_SESSION` 409.
   */
  details?: Record<string, unknown>;
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
  readonly details?: Record<string, unknown>;

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
    this.details = envelope?.details;
  }
}

/** Resolved auth token + its source (file/env/oauth) — shared by JSON and multipart requests. */
function requireToken(): { token: string; source: string } {
  const tokenResult = getTokenWithSource();
  if (!tokenResult) {
    throw new Error(notLoggedInMessage());
  }
  return tokenResult;
}

async function doFetch(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: BodyInit | undefined,
  start: number
): Promise<Response> {
  const url = `${config.apiUrl}${path}`;
  try {
    return await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  } catch (err) {
    const ms = Date.now() - start;
    const cause = err instanceof Error
      ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}`
      : String(err);
    log("api", "✗ " + method + " " + path + " network error (" + ms + "ms)", { error: cause });
    throw new Error(`Cannot reach PostKing at ${url}: ${cause}`);
  }
}

async function handleResponse<T>(
  res: Response,
  method: string,
  path: string,
  start: number,
  source: string
): Promise<T> {
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
      // Prefer the explicit machine-readable `reason` the server sends for a
      // revoked/expired/malformed key; fall back to a message-text match for
      // older server versions that don't emit `reason` yet.
      const isInvalidKey =
        envelope?.code === "UNAUTHORIZED" &&
        (envelope.reason === "key_invalid" || /invalid|revoked/i.test(envelope.message ?? ""));

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

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { token, source } = requireToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (oauthConfig.internalSecret) {
    headers["x-internal-secret"] = oauthConfig.internalSecret;
  }

  const start = Date.now();
  log("api", "→ " + method + " " + path, { source });

  const res = await doFetch(method, path, headers, body !== undefined ? JSON.stringify(body) : undefined, start);
  return handleResponse<T>(res, method, path, start, source);
}

/**
 * Same auth/error handling as `request`, but sends a `multipart/form-data`
 * body (native `FormData`) instead of JSON — used for
 * `import_landing_page_bundle`'s forward-to-agent-v1 call. Deliberately does
 * NOT set a `Content-Type` header: the platform `fetch` implementation
 * (undici, on Node >=18) sets the correct `multipart/form-data; boundary=...`
 * header itself when the body is a `FormData` instance.
 */
async function requestMultipart<T>(
  method: string,
  path: string,
  form: FormData
): Promise<T> {
  const { token, source } = requireToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (oauthConfig.internalSecret) {
    headers["x-internal-secret"] = oauthConfig.internalSecret;
  }

  const start = Date.now();
  log("api", "→ " + method + " " + path, { source });

  const res = await doFetch(method, path, headers, form, start);
  return handleResponse<T>(res, method, path, start, source);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
  postMultipart: <T>(path: string, form: FormData) => requestMultipart<T>("POST", path, form),
};
