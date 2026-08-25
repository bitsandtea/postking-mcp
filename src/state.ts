// In-process state for the MCP server.
// Active brand is keyed by the authenticated user ID (introspected token
// `sub`) so it survives session re-initialization — e.g. a client silently
// starting a new session after a server redeploy invalidates the old one.
// Falls back to session ID, then "stdio", when no user ID is available
// (stdio transport never runs introspection, so it always uses "stdio").

import { getSessionId, getUserId } from "./config.js";

const activeBrandIds = new Map<string, string>();

/** Simple cap so an unbounded stream of distinct keys can't grow forever. */
const MAX_ENTRIES = 5000;

/** Resolve the state key: user ID > session ID > "stdio". */
function resolveStateKey(): string {
  return getUserId() ?? getSessionId() ?? "stdio";
}

export function getActiveBrandId(): string | null {
  return activeBrandIds.get(resolveStateKey()) ?? null;
}

export function setActiveBrandId(id: string): void {
  const key = resolveStateKey();
  // Evict the oldest inserted entry before adding a new key past the cap.
  // Re-setting an existing key doesn't grow the map, so skip the check then.
  if (!activeBrandIds.has(key) && activeBrandIds.size >= MAX_ENTRIES) {
    const oldestKey = activeBrandIds.keys().next().value;
    if (oldestKey !== undefined) activeBrandIds.delete(oldestKey);
  }
  activeBrandIds.set(key, id);
}

export function requireBrandId(explicit?: string): string {
  const id = explicit ?? activeBrandIds.get(resolveStateKey());
  if (!id) {
    throw new Error(
      "No brand selected. Call list_brands to see your brands, then set_active_brand to choose one."
    );
  }
  return id;
}

/**
 * Remove state keyed by this exact session ID — the legacy/fallback path
 * (stdio, or an HTTP request that ran with no user ID). Never deletes a
 * user-keyed entry: a user's active-brand selection must survive individual
 * session closes so it's still there after the client silently re-inits.
 */
export function deleteSessionState(sessionId: string): void {
  activeBrandIds.delete(sessionId);
}
