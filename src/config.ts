import { loadStoredToken } from "./auth.js";

export const config = {
  apiUrl: process.env.POSTKING_API_URL ?? "https://try.postking.app",
  pollIntervalMs: 3000,
  pollTimeoutMs: 120_000,
} as const;

export function getToken(): string | null {
  return process.env.POSTKING_API_TOKEN ?? loadStoredToken();
}

export function requireToken(): string {
  const token = getToken();
  if (!token) {
    throw new Error(
      "Not logged in. Call the login_start tool to authenticate with PostKing."
    );
  }
  return token;
}
