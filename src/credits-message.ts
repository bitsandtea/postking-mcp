/**
 * Human/agent-readable cost line for an agent-v1 `INSUFFICIENT_CREDITS` (HTTP 402)
 * envelope. The server (docs/134-credit-metering) attaches
 * `details: { action, needed, balance, affordableCount, topUpUrl }`; older servers
 * send none of it, in which case this returns undefined and callers fall back to
 * the generic out-of-credits text.
 *
 * A 402 is a billing condition, never an auth failure - callers must not clear
 * the stored token for it.
 */
export function insufficientCreditsCostLine(
  details: Record<string, unknown> | undefined
): string | undefined {
  if (!details || typeof details.needed !== "number") return undefined;
  const action = typeof details.action === "string" && details.action ? ` for ${details.action}` : "";
  const balance = typeof details.balance === "number" ? ` Current balance: ${details.balance}.` : "";
  const fits =
    typeof details.affordableCount === "number" && details.affordableCount > 0
      ? ` The balance covers ${details.affordableCount} of the requested items - retry with fewer.`
      : "";
  const topUp = typeof details.topUpUrl === "string" ? ` Top-up page: ${details.topUpUrl}` : "";
  return `Not enough credits: this needs ${details.needed} credits${action}.${balance}${fits}${topUp}`;
}
