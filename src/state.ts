// In-process state for the MCP server session.
// The agent calls set_active_brand once; subsequent tools pick it up automatically.

let activeBrandId: string | null = null;

export function getActiveBrandId(): string | null {
  return activeBrandId;
}

export function setActiveBrandId(id: string): void {
  activeBrandId = id;
}

export function requireBrandId(explicit?: string): string {
  const id = explicit ?? activeBrandId;
  if (!id) {
    throw new Error(
      "No brand selected. Call list_brands to see your brands, then set_active_brand to choose one."
    );
  }
  return id;
}
