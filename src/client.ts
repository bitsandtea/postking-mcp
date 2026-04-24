import { config, requireToken } from "./config.js";

export interface AgentErrorEnvelope {
  code?: string;
  message?: string;
  docsUrl?: string;
  retryable?: boolean;
  checkoutUrl?: string;
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

  constructor(status: number, message: string, envelope?: AgentErrorEnvelope) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope?.code;
    this.docsUrl = envelope?.docsUrl;
    this.retryable = envelope?.retryable;
    this.checkoutUrl = envelope?.checkoutUrl;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = requireToken();
  const url = `${config.apiUrl}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

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

    if (res.status === 401) {
      throw new ApiError(
        401,
        envelope?.message ?? "Not authenticated. Check your POSTKING_API_TOKEN.",
        envelope
      );
    }
    if (res.status === 402) {
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

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
