import { config, requireToken } from "./config.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
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
    try {
      const json = (await res.json()) as { error?: string; message?: string };
      message = json.error ?? json.message ?? message;
    } catch {
      // ignore
    }

    if (res.status === 401) throw new ApiError(401, "Not authenticated. Check your POSTKING_API_TOKEN.");
    if (res.status === 402) throw new ApiError(402, `Insufficient credits: ${message}`);
    if (res.status === 403) throw new ApiError(403, `Access denied: ${message}`);
    if (res.status === 404) throw new ApiError(404, `Not found: ${message}`);
    throw new ApiError(res.status, message);
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
