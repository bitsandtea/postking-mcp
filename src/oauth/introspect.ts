/**
 * Token introspection cache + validation for the OAuth Resource Server.
 * See docs/06-hermes-hackathon/08-oauth-native-mcp.md §5.3
 *
 * Tokens are validated via a POST to the PostKing API's introspection endpoint.
 * Results are cached by SHA-256 hash of the raw token — the raw token is never
 * stored in memory or logged.
 */
import { createHash } from "node:crypto";
import { config, oauthConfig } from "../config.js";

export interface IntrospectionResult {
  sub: string;
  scope: string;
  brand_id: string | null;
  brand_ids?: string[];
  client_id: string | null;
  exp: number;
}

interface CacheEntry {
  result: IntrospectionResult;
  cachedAt: number;
}

interface IntrospectionResponse {
  active: boolean;
  sub?: string;
  scope?: string;
  brand_id?: string | null;
  brand_ids?: string[];
  client_id?: string | null;
  exp?: number;
  aud?: string | string[];
}

const CACHE_TTL_MS = 45_000;

const cache = new Map<string, CacheEntry>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt > CACHE_TTL_MS;
}

/**
 * Introspect a bearer token against the PostKing API.
 *
 * Throws with a `status` property on the error for structured HTTP responses:
 * - 401: token missing, inactive, expired, or wrong audience
 * - 403: insufficient scope (caller checks scope; this fn does not check scope)
 *
 * Returns the introspection result on success.
 */
export async function introspectToken(token: string): Promise<IntrospectionResult> {
  const hash = tokenHash(token);

  const cached = cache.get(hash);
  if (cached && !isExpired(cached)) {
    // Even on a cache hit, reject if the token's actual exp has passed —
    // the cache TTL (45s) may outlive a short-lived token.
    const nowSecs = Math.floor(Date.now() / 1000);
    if (cached.result.exp < nowSecs) {
      cache.delete(hash);
      // Fall through to fresh introspection below.
    } else {
      return cached.result;
    }
  }

  const secret = oauthConfig.internalSecret;
  if (!secret) {
    throw Object.assign(
      new Error("POSTKING_INTERNAL_SECRET is not configured — cannot introspect tokens"),
      { status: 500 }
    );
  }

  const url = `${config.apiUrl}/api/oauth/introspect`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw Object.assign(
      new Error(`Cannot reach introspection endpoint: ${cause}`),
      { status: 503 }
    );
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`Introspection endpoint returned HTTP ${res.status}`),
      { status: 401 }
    );
  }

  const data = (await res.json()) as IntrospectionResponse;

  if (!data.active) {
    throw Object.assign(new Error("Token is not active"), { status: 401 });
  }

  // Check expiry against wall clock
  const nowSecs = Math.floor(Date.now() / 1000);
  if (data.exp === undefined || data.exp < nowSecs) {
    throw Object.assign(new Error("Token has expired or has no expiry"), { status: 401 });
  }

  // Audience check — fail CLOSED (RFC 8707): absent aud is a rejection, not a pass.
  const resourceUri = oauthConfig.resourceUri;
  const audList = Array.isArray(data.aud) ? data.aud : data.aud ? [data.aud] : [];
  if (!audList.includes(resourceUri)) {
    throw Object.assign(
      new Error(`Token audience does not include this resource (${resourceUri})`),
      { status: 401 }
    );
  }

  const result: IntrospectionResult = {
    sub: data.sub ?? "",
    scope: data.scope ?? "",
    brand_id: data.brand_id ?? null,
    brand_ids: data.brand_ids,
    client_id: data.client_id ?? null,
    exp: data.exp,
  };

  cache.set(hash, { result, cachedAt: Date.now() });
  return result;
}
