/**
 * SSRF-hardened, size-capped HTTP(S) fetcher for server-side requests to
 * caller-supplied URLs (currently: `bundleImport.ts`'s manifest file fetches
 * for the `import_landing_page_bundle` MCP tool). The hosted MCP server runs
 * on the prod box, so a naive `fetch()` of an attacker-controlled URL is a
 * real internal-network-read vector — this module closes that off without
 * pulling in a new dependency.
 *
 * What it guards against, and how:
 *   - Loopback/private/link-local/metadata addresses (`net.BlockList`,
 *     checked against every DNS-resolved candidate, not just the first).
 *   - Bracketed IPv6 literals (`[::1]`) and IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
 *     — `URL#hostname` keeps the brackets, so they're stripped before
 *     validation; `net.BlockList` already compares mapped addresses against
 *     the IPv4 rules internally, and the mapped-IPv4 payload is additionally
 *     extracted and checked against the IPv4 list directly as a second,
 *     independent check.
 *   - Public DNS names that resolve to a private address (`localtest.me`,
 *     `localhost.` with its trailing dot) — validated post-lookup, not by
 *     pattern-matching the hostname string.
 *   - DNS rebinding (TOCTOU between the check and the connect) — resolution
 *     happens once via `dns.lookup`, every candidate address is validated,
 *     and the request's `lookup` option is pinned to the one address we
 *     checked, so the OS never re-resolves at connect time.
 *   - Redirects to an internal address — the underlying `http`/`https`
 *     client is never allowed to auto-follow; every hop (up to 3) is
 *     resolved and re-validated exactly like the initial URL.
 *   - Unbounded response bodies — a `Content-Length` pre-check plus a
 *     streaming byte counter (optionally shared across an entire multi-file
 *     operation via `ByteBudget`) aborts the connection as soon as either
 *     cap would be exceeded.
 *   - Slow-body DoS — a single deadline timer covers DNS resolution through
 *     the full body read; it is never cleared/reset just because headers
 *     arrived.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/**
 * A byte budget shared across every fetch in one logical operation (e.g. all
 * files in one bundle import). Each `safeFetch` call decrements it as bytes
 * actually arrive, so concurrent fetches can't collectively blow past the
 * total even though each one only sees its own per-file cap.
 */
export class ByteBudget {
  private remaining: number;

  constructor(totalBytes: number) {
    this.remaining = totalBytes;
  }

  get remainingBytes(): number {
    return this.remaining;
  }

  /** Reserves `n` bytes if they fit; returns false (no-op) if they'd overrun the budget. */
  tryConsume(n: number): boolean {
    if (n > this.remaining) return false;
    this.remaining -= n;
    return true;
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Covers DNS resolution through the full body read, across all redirect hops. Default 30s. */
  timeoutMs?: number;
  /** Max additional hops after the first request. Default 3. */
  maxRedirects?: number;
  /** Hard cap on this fetch's response body, in bytes. */
  maxBodyBytes: number;
  /** Optional cross-fetch shared budget (see `ByteBudget`). */
  budget?: ByteBudget;
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The final URL after following redirects. */
  url: string;
  body: Buffer;
}

// ── SSRF address validation ────────────────────────────────────────────────

function buildPrivateBlockList(): BlockList {
  const bl = new BlockList();
  // IPv4
  bl.addSubnet("0.0.0.0", 8, "ipv4");
  bl.addSubnet("10.0.0.0", 8, "ipv4");
  bl.addSubnet("100.64.0.0", 10, "ipv4");
  bl.addSubnet("127.0.0.0", 8, "ipv4");
  bl.addSubnet("169.254.0.0", 16, "ipv4");
  bl.addSubnet("172.16.0.0", 12, "ipv4");
  bl.addSubnet("192.0.0.0", 24, "ipv4");
  bl.addSubnet("192.168.0.0", 16, "ipv4");
  bl.addSubnet("198.18.0.0", 15, "ipv4");
  bl.addSubnet("224.0.0.0", 4, "ipv4");
  bl.addSubnet("240.0.0.0", 4, "ipv4");
  bl.addAddress("255.255.255.255", "ipv4");
  // IPv6
  bl.addSubnet("::", 128, "ipv6");
  bl.addSubnet("::1", 128, "ipv6");
  // Deliberately NOT adding ::ffff:0:0/96 as its own rule here: Node's
  // BlockList already compares an IPv6-mapped address (`::ffff:a.b.c.d`)
  // against the IPv4 subnets above internally (confirmed empirically — an
  // IPv4-mapped 127.0.0.1 is blocked by the `127.0.0.0/8` rule with no
  // ::ffff:0:0/96 entry present). Adding ::ffff:0:0/96 explicitly instead
  // makes EVERY plain IPv4 `check(addr, "ipv4")` call return blocked,
  // because BlockList unifies v4/v6 comparison through the mapped form —
  // it would refuse every public IPv4 address, not just private ones. The
  // `extractIPv4Mapped` + IPv4-list check below stays as explicit,
  // independently-verified defense-in-depth for the mapped-address case.
  bl.addSubnet("fc00::", 7, "ipv6");
  bl.addSubnet("fe80::", 10, "ipv6");
  bl.addSubnet("ff00::", 8, "ipv6");
  bl.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 well-known prefix
  return bl;
}

const PRIVATE_BLOCK_LIST = buildPrivateBlockList();
const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
const IPV4_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** Extracts the embedded IPv4 address from an IPv4-mapped IPv6 literal, in either dotted or hex-group form. */
function extractIPv4Mapped(address: string): string | null {
  const dotted = address.match(IPV4_MAPPED_RE);
  if (dotted) return dotted[1];
  const hex = address.match(IPV4_MAPPED_HEX_RE);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isBlockedAddress(address: string, family: 4 | 6): boolean {
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (PRIVATE_BLOCK_LIST.check(address, kind)) return true;
  if (family === 6) {
    const mapped = extractIPv4Mapped(address);
    if (mapped && PRIVATE_BLOCK_LIST.check(mapped, "ipv4")) return true;
  }
  return false;
}

/** Strips a bracketed-IPv6 host down to the literal, and drops a trailing FQDN dot. */
function normalizeHost(hostname: string): string {
  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` to every candidate address and throws unless ALL of
 * them are public. A literal IP is validated directly (no DNS lookup, so
 * there's nothing for a resolver to lie about).
 */
async function resolveValidated(hostname: string): Promise<ResolvedTarget[]> {
  const literalFamily = isIP(hostname);
  let candidates: ResolvedTarget[];
  if (literalFamily !== 0) {
    candidates = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    const looked = await dnsLookup(hostname, { all: true });
    if (looked.length === 0) {
      throw new SafeFetchError(`DNS lookup for "${hostname}" returned no addresses`);
    }
    candidates = looked.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  }
  for (const c of candidates) {
    if (isBlockedAddress(c.address, c.family)) {
      throw new SafeFetchError(`refused: "${hostname}" resolves to non-public address ${c.address}`);
    }
  }
  return candidates;
}

function validateScheme(urlObj: URL): void {
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new SafeFetchError(`refused non-http(s) URL scheme "${urlObj.protocol}"`);
  }
}

// ── Deadline covering DNS resolution through the full body read ───────────

class Deadline {
  private readonly timer: NodeJS.Timeout;
  private expired = false;
  private readonly listeners = new Set<() => void>();

  constructor(ms: number) {
    this.timer = setTimeout(() => {
      this.expired = true;
      for (const cb of this.listeners) cb();
    }, ms);
    this.timer.unref?.();
  }

  isExpired(): boolean {
    return this.expired;
  }

  /** Registers a callback for when the deadline fires; returns an unsubscribe function. */
  onExpire(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

/** Races a promise against the deadline without cancelling the underlying work (DNS lookups can't be cancelled). */
function withDeadline<T>(promise: Promise<T>, deadline: Deadline, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const unsubscribe = deadline.onExpire(() => {
      if (done) return;
      done = true;
      reject(new SafeFetchError(timeoutMessage));
    });
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        unsubscribe();
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        unsubscribe();
        reject(err);
      }
    );
  });
}

// ── Request issuing ────────────────────────────────────────────────────────

type LookupFn = NonNullable<http.RequestOptions["lookup"]>;
type DnsCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type DnsAllCallback = (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void;

/**
 * Pins DNS resolution to the address we already validated — this is what
 * defeats rebinding (no second lookup at connect time). Node's connection
 * layer uses Happy Eyeballs (RFC 8305) by default for dual-stack hosts,
 * which calls a custom `lookup` with `options.all: true` and expects an
 * array of `{address, family}` back rather than a single address/family
 * pair — handle both calling conventions. Cast to `LookupFn` at the call
 * site (not here) to avoid contextually typing this body against the SDK's
 * (narrower) declared overload.
 */
function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    optionsOrCallback: { all?: boolean } | DnsCallback,
    maybeCallback?: DnsCallback | DnsAllCallback
  ): void => {
    if (typeof optionsOrCallback === "function") {
      // Legacy 2-arg form: lookup(hostname, callback).
      optionsOrCallback(null, address, family);
      return;
    }
    if (optionsOrCallback?.all) {
      (maybeCallback as DnsAllCallback)(null, [{ address, family }]);
    } else {
      (maybeCallback as DnsCallback)(null, address, family);
    }
  };
}

function issueRequest(urlObj: URL, target: ResolvedTarget, method: string, headers: Record<string, string>): http.ClientRequest {
  const isHttps = urlObj.protocol === "https:";
  const mod = isHttps ? https : http;
  const hostname = normalizeHost(urlObj.hostname);
  const port = urlObj.port ? Number(urlObj.port) : isHttps ? 443 : 80;
  const path = urlObj.pathname + urlObj.search;
  const options: http.RequestOptions & { servername?: string } = {
    method,
    hostname,
    port,
    path,
    headers,
    lookup: pinnedLookup(target.address, target.family) as LookupFn,
  };
  if (isHttps) options.servername = hostname;
  return mod.request(options);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface HopSuccess {
  kind: "success";
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}
interface HopRedirect {
  kind: "redirect";
  location: URL;
}
type HopResult = HopSuccess | HopRedirect;

function readBodyWithCap(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  maxBodyBytes: number,
  budget: ByteBudget | undefined
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      res.destroy();
      req.destroy();
      reject(err);
    };

    res.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        fail(new SafeFetchError(`response body exceeds the ${maxBodyBytes}-byte cap`));
        return;
      }
      if (budget && !budget.tryConsume(chunk.length)) {
        fail(new SafeFetchError("response body exceeds the shared byte budget for this operation"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    res.on("error", fail);
    req.on("error", fail);
  });
}

async function performHop(
  urlObj: URL,
  method: string,
  headers: Record<string, string>,
  maxBodyBytes: number,
  budget: ByteBudget | undefined,
  deadline: Deadline
): Promise<HopResult> {
  validateScheme(urlObj);
  const hostname = normalizeHost(urlObj.hostname);
  const targets = await withDeadline(resolveValidated(hostname), deadline, `DNS resolution for "${hostname}" timed out`);
  const target = targets[0];

  const req = issueRequest(urlObj, target, method, headers);
  const unsubscribeTimeout = deadline.onExpire(() => req.destroy(new SafeFetchError("request timed out")));

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    });

    if (res.statusCode && REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
      res.resume(); // discard any body on a redirect
      const nextUrl = new URL(res.headers.location, urlObj);
      return { kind: "redirect", location: nextUrl };
    }

    const contentLengthHeader = res.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      const effectiveCap = budget ? Math.min(maxBodyBytes, budget.remainingBytes) : maxBodyBytes;
      if (Number.isFinite(declared) && declared > effectiveCap) {
        res.destroy();
        req.destroy();
        throw new SafeFetchError(`Content-Length ${declared} exceeds the ${effectiveCap}-byte cap`);
      }
    }

    const body = await readBodyWithCap(req, res, maxBodyBytes, budget);
    return { kind: "success", status: res.statusCode ?? 0, headers: res.headers, body, url: urlObj.toString() };
  } finally {
    unsubscribeTimeout();
  }
}

/**
 * Fetches `inputUrl`, following up to `maxRedirects` (default 3) same-shape
 * redirects, with every hop independently DNS-resolved and validated as
 * public, and the response body capped at `maxBodyBytes` (and optionally a
 * shared `budget` across a whole multi-file operation).
 */
export async function safeFetch(inputUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const method = opts.method ?? "GET";
  const headers = opts.headers ?? {};
  const deadline = new Deadline(timeoutMs);

  try {
    let currentUrl: URL;
    try {
      currentUrl = new URL(inputUrl);
    } catch {
      throw new SafeFetchError(`invalid URL "${inputUrl}"`);
    }

    for (let hop = 0; ; hop++) {
      if (deadline.isExpired()) {
        throw new SafeFetchError(`request timed out after ${timeoutMs}ms`);
      }
      const result = await performHop(currentUrl, method, headers, opts.maxBodyBytes, opts.budget, deadline);
      if (result.kind === "redirect") {
        if (hop >= maxRedirects) {
          throw new SafeFetchError(`too many redirects (>${maxRedirects}) fetching "${inputUrl}"`);
        }
        currentUrl = result.location;
        continue;
      }
      return { status: result.status, headers: result.headers, url: result.url, body: result.body };
    }
  } finally {
    deadline.clear();
  }
}
