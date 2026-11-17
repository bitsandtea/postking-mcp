/**
 * One login attempt = one device-authorization request.
 *
 * `login_start` used to create a fresh request on the server every time it
 * was called — after a timeout, a retry, or a client restart — leaving a
 * trail of never-approved requests and stranding links the user had already
 * approved. The in-flight request is now kept here (in memory and in
 * `~/.postking/pending-login.json`, so it survives a restart of the stdio
 * server) and reused until it expires or is redeemed.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Name recorded on every device request this server creates. */
export const DEVICE_CLIENT_NAME = "postking-mcp";

/** `postking-mcp/<version>` — sent as User-Agent on the device-flow calls. */
export function deviceUserAgent(): string {
  try {
    // `src/` (tsx) and `dist/` both sit one level below package.json.
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return `${DEVICE_CLIENT_NAME}/${pkg.version ?? "0.0.0"}`;
  } catch {
    return `${DEVICE_CLIENT_NAME}/0.0.0`;
  }
}

const PENDING_DIR = join(homedir(), ".postking");
const PENDING_FILE = join(PENDING_DIR, "pending-login.json");

/** A request with less time left than this is not worth showing again. */
export const MIN_REMAINING_MS = 2 * 60 * 1000;

export interface PendingLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Poll interval, seconds. */
  interval: number;
  /** Epoch ms. */
  expiresAt: number;
  /** API the request was created on — a request never crosses environments. */
  apiUrl: string;
}

/** Shape check for a value read back from disk. */
export function parsePendingLogin(raw: unknown): PendingLogin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.deviceCode !== "string" || !r.deviceCode ||
    typeof r.userCode !== "string" || !r.userCode ||
    typeof r.verificationUri !== "string" || !r.verificationUri ||
    typeof r.apiUrl !== "string" || !r.apiUrl ||
    typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)
  ) {
    return null;
  }
  const interval = typeof r.interval === "number" && r.interval >= 1 ? r.interval : 5;
  return {
    deviceCode: r.deviceCode,
    userCode: r.userCode,
    verificationUri: r.verificationUri,
    interval,
    expiresAt: r.expiresAt,
    apiUrl: r.apiUrl,
  };
}

/** True when `pending` can still be approved and redeemed against `apiUrl`. */
export function isReusablePendingLogin(
  pending: PendingLogin | null,
  apiUrl: string,
  now: number = Date.now(),
  minRemainingMs: number = MIN_REMAINING_MS
): pending is PendingLogin {
  if (!pending) return false;
  if (pending.apiUrl !== apiUrl) return false;
  return pending.expiresAt - now > minRemainingMs;
}

export type ReuseDecision = "logged_in" | "show_again" | "start_new";

/**
 * What `login_start` does with an existing request, given the token
 * endpoint's answer for it: redeem it (the user already approved), show the
 * same link again (still waiting), or drop it and create a new one.
 */
export function decideReuse(tokenResponse: { access_token?: unknown; error?: unknown } | null): ReuseDecision {
  if (!tokenResponse) return "start_new";
  if (typeof tokenResponse.access_token === "string" && tokenResponse.access_token) return "logged_in";
  if (tokenResponse.error === "authorization_pending" || tokenResponse.error === "slow_down") return "show_again";
  return "start_new";
}

let cached: PendingLogin | null | undefined;

export function loadPendingLogin(): PendingLogin | null {
  if (cached !== undefined) return cached;
  try {
    cached = parsePendingLogin(JSON.parse(readFileSync(PENDING_FILE, "utf-8")));
  } catch {
    cached = null;
  }
  return cached;
}

export function savePendingLogin(pending: PendingLogin): void {
  cached = pending;
  try {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Read-only home: the in-memory copy still covers this process.
  }
}

export function clearPendingLogin(): void {
  cached = null;
  try {
    unlinkSync(PENDING_FILE);
  } catch {
    // already gone
  }
}
