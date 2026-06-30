import { api } from "./client.js";
import { config } from "./config.js";

interface WithOperationStatus {
  operationStatus?: string | Record<string, unknown> | null;
}

/**
 * Covers both the real Prisma OperationState values and the legacy
 * "status" shape emitted by the brand-onboarding shim:
 *
 *   Legacy (brand operationStatus column / legacyShim):
 *     pending, processing  — non-terminal
 *     completed            — success
 *     completed_with_errors — terminal failure (partially_failed via shim)
 *     failed               — terminal failure
 *
 *   Prisma OperationState (Operation rows / future direct serialisation):
 *     pending, running     — non-terminal
 *     completed            — success
 *     partially_failed, failed, cancelled — terminal failure
 *
 * NOTE: the brand endpoint uses the field name `status`, not `state`.
 * Both are checked below for forward-compatibility.
 */
interface OperationStatus {
  /** Real Prisma OperationState or legacy mapped value */
  state?: "pending" | "running" | "completed" | "partially_failed" | "failed" | "cancelled";
  /** Legacy brand operationStatus shape — the actual field emitted by the shim */
  status?: "pending" | "processing" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled" | "partially_failed";
  error?: string;
}

function parseStatus(raw: unknown): OperationStatus | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj as OperationStatus;
  } catch {
    return null;
  }
}

/** Terminal-failure state values (either field). */
const TERMINAL_FAILURE = new Set([
  "failed",
  "partially_failed",
  "cancelled",
  "completed_with_errors",
]);

/**
 * Poll a URL until operationStatus reaches a terminal state.
 *
 * Success  — state/status === "completed"  → returns the final response body.
 * Failure  — state/status is a terminal-failure value → throws with the state
 *            and any error message from the operation.
 * In-flight — pending | processing | running (and any unrecognised value) →
 *             keeps polling until the deadline.
 */
export async function pollUntilDone<T extends WithOperationStatus>(
  pollUrl: string
): Promise<T> {
  const deadline = Date.now() + config.pollTimeoutMs;

  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);

    const data = await api.get<T>(pollUrl);
    const parsed = parseStatus(data.operationStatus);

    if (!parsed) continue;

    // Prefer the `status` field (legacy brand shape); fall back to `state`
    // (Prisma OperationState, used if the endpoint serialises the row directly).
    const effectiveState: string | undefined = parsed.status ?? parsed.state;

    if (!effectiveState) continue;

    if (effectiveState === "completed") return data;

    if (TERMINAL_FAILURE.has(effectiveState)) {
      throw new Error(
        `Operation ended with terminal state '${effectiveState}': ${parsed.error ?? "no error detail"}`
      );
    }

    // Non-terminal: pending | processing | running | (unrecognised) → keep polling
  }

  throw new Error(`Operation timed out after ${config.pollTimeoutMs / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
