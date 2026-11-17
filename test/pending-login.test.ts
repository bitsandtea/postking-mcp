import { describe, expect, it } from "vitest";
import {
  decideReuse,
  isReusablePendingLogin,
  MIN_REMAINING_MS,
  parsePendingLogin,
  type PendingLogin,
} from "../src/pendingLogin.js";

const NOW = 1_800_000_000_000;
const API = "https://try.postking.app";

function pending(overrides: Partial<PendingLogin> = {}): PendingLogin {
  return {
    deviceCode: "d".repeat(64),
    userCode: "ABCD-1234",
    verificationUri: `${API}/activate/ABCD-1234`,
    interval: 5,
    expiresAt: NOW + 30 * 60 * 1000,
    apiUrl: API,
    ...overrides,
  };
}

describe("isReusablePendingLogin", () => {
  it("reuses a request that is still comfortably valid", () => {
    expect(isReusablePendingLogin(pending(), API, NOW)).toBe(true);
  });

  it("does not reuse when there is none", () => {
    expect(isReusablePendingLogin(null, API, NOW)).toBe(false);
  });

  it("does not reuse an expired or nearly expired request", () => {
    expect(isReusablePendingLogin(pending({ expiresAt: NOW - 1 }), API, NOW)).toBe(false);
    expect(isReusablePendingLogin(pending({ expiresAt: NOW + MIN_REMAINING_MS }), API, NOW)).toBe(false);
    expect(isReusablePendingLogin(pending({ expiresAt: NOW + MIN_REMAINING_MS + 1 }), API, NOW)).toBe(true);
  });

  it("does not reuse a request created on another API", () => {
    expect(isReusablePendingLogin(pending(), "http://localhost:3000", NOW)).toBe(false);
  });
});

describe("decideReuse", () => {
  it("redeems a request the user already approved", () => {
    expect(decideReuse({ access_token: "pk_live_x" })).toBe("logged_in");
  });

  it("shows the same link again while approval is pending", () => {
    expect(decideReuse({ error: "authorization_pending" })).toBe("show_again");
    expect(decideReuse({ error: "slow_down" })).toBe("show_again");
  });

  it("starts over on expiry, an unknown code, a denial or no answer", () => {
    expect(decideReuse({ error: "expired_token" })).toBe("start_new");
    expect(decideReuse({ error: "invalid_grant" })).toBe("start_new");
    expect(decideReuse({ error: "access_denied" })).toBe("start_new");
    expect(decideReuse({})).toBe("start_new");
    expect(decideReuse(null)).toBe("start_new");
  });
});

describe("parsePendingLogin", () => {
  it("round-trips a saved request", () => {
    const p = pending();
    expect(parsePendingLogin(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("defaults a missing interval and rejects incomplete records", () => {
    const { interval: _interval, ...withoutInterval } = pending();
    expect(parsePendingLogin(withoutInterval)?.interval).toBe(5);
    expect(parsePendingLogin({ deviceCode: "x" })).toBeNull();
    expect(parsePendingLogin("nope")).toBeNull();
    expect(parsePendingLogin(null)).toBeNull();
  });
});
