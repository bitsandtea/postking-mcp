import { api } from "./client.js";
import { config } from "./config.js";

interface WithOperationStatus {
  operationStatus?: string | Record<string, unknown> | null;
}

interface OperationStatus {
  state: "pending" | "processing" | "completed" | "failed";
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

/**
 * Poll a URL until operationStatus.state is "completed" or "failed".
 * Returns the final response body.
 */
export async function pollUntilDone<T extends WithOperationStatus>(
  pollUrl: string
): Promise<T> {
  const deadline = Date.now() + config.pollTimeoutMs;

  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);

    const data = await api.get<T>(pollUrl);
    const status = parseStatus(data.operationStatus);

    if (!status) continue;

    if (status.state === "completed") return data;
    if (status.state === "failed") {
      throw new Error(`Operation failed: ${status.error ?? "unknown error"}`);
    }
  }

  throw new Error(`Operation timed out after ${config.pollTimeoutMs / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
