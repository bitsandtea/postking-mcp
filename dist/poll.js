import { api } from "./client.js";
import { config } from "./config.js";
function parseStatus(raw) {
    if (!raw)
        return null;
    try {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        return obj;
    }
    catch {
        return null;
    }
}
/**
 * Poll a URL until operationStatus.state is "completed" or "failed".
 * Returns the final response body.
 */
export async function pollUntilDone(pollUrl) {
    const deadline = Date.now() + config.pollTimeoutMs;
    while (Date.now() < deadline) {
        await sleep(config.pollIntervalMs);
        const data = await api.get(pollUrl);
        const status = parseStatus(data.operationStatus);
        if (!status)
            continue;
        if (status.state === "completed")
            return data;
        if (status.state === "failed") {
            throw new Error(`Operation failed: ${status.error ?? "unknown error"}`);
        }
    }
    throw new Error(`Operation timed out after ${config.pollTimeoutMs / 1000}s`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=poll.js.map