// In-process state for the MCP server session.
// State is keyed by session ID so concurrent HTTP sessions don't share globals.
// On stdio (one session), the ALS falls back to "stdio" as the session key.

import { getSessionId } from "./config.js";

const activeBrandIds = new Map<string, string>();

/** Resolve the session ID: use the ALS value when available, fall back to "stdio". */
function resolveSessionId(): string {
  return getSessionId() ?? "stdio";
}

export function getActiveBrandId(): string | null {
  return activeBrandIds.get(resolveSessionId()) ?? null;
}

export function setActiveBrandId(id: string): void {
  activeBrandIds.set(resolveSessionId(), id);
}

export function requireBrandId(explicit?: string): string {
  const id = explicit ?? activeBrandIds.get(resolveSessionId());
  if (!id) {
    throw new Error(
      "No brand selected. Call list_brands to see your brands, then set_active_brand to choose one."
    );
  }
  return id;
}

/** Remove all per-session state. Call on session close to avoid memory leaks. */
export function deleteSessionState(sessionId: string): void {
  activeBrandIds.delete(sessionId);
}
