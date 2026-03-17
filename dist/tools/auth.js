import { config, getToken } from "../config.js";
import { saveToken, deleteToken } from "../auth.js";
// Shared in-process state for the two-step device flow
let pendingDeviceCode = null;
async function fetchJson(path, body) {
    const url = `${config.apiUrl}${path}`;
    let res;
    try {
        res = await fetch(url, {
            method: body !== undefined ? "POST" : "GET",
            headers: { "Content-Type": "application/json" },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    }
    catch (err) {
        const cause = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ""}` : String(err);
        throw new Error(`Cannot reach PostKing at ${url}: ${cause}`);
    }
    if (!res.ok) {
        throw new Error(`PostKing API error ${res.status} at ${url}`);
    }
    return res.json();
}
export function registerAuthTools(server) {
    // ── login_start ───────────────────────────────────────────────────────────
    server.tool("login_start", [
        "Start the PostKing login flow. Returns a URL and short code for the user to visit in their browser.",
        "After the user approves, call login_complete to finish and save the token.",
    ].join(" "), {}, async () => {
        // Already logged in?
        const existing = getToken();
        if (existing) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Already logged in. Call logout first if you want to switch accounts.",
                    },
                ],
            };
        }
        const data = await fetchJson("/api/agent/auth/device/code", {});
        if (!data.device_code) {
            throw new Error("Failed to start login: no device_code returned.");
        }
        pendingDeviceCode = data.device_code;
        return {
            content: [
                {
                    type: "text",
                    text: [
                        "**PostKing Login**",
                        "",
                        `1. Visit: ${data.verification_uri}`,
                        `2. Enter code: **${data.user_code}**`,
                        "",
                        "Once you've approved it in the browser, tell me and I'll call login_complete.",
                        `(Code expires in ${Math.floor(data.expires_in / 60)} minutes)`,
                    ].join("\n"),
                },
            ],
        };
    });
    // ── login_complete ────────────────────────────────────────────────────────
    server.tool("login_complete", "Finish the PostKing login flow after the user has approved the code in their browser. Saves the token locally.", {}, async () => {
        if (!pendingDeviceCode) {
            throw new Error("No login in progress. Call login_start first.");
        }
        const data = await fetchJson("/api/agent/auth/device/token", { device_code: pendingDeviceCode });
        if (data.error) {
            if (data.error === "authorization_pending") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Still waiting for approval. Please visit the link and approve, then try login_complete again.",
                        },
                    ],
                };
            }
            if (data.error === "expired_token") {
                pendingDeviceCode = null;
                throw new Error("Login code expired. Call login_start to begin again.");
            }
            throw new Error(`Login failed: ${data.error}`);
        }
        if (!data.access_token) {
            throw new Error("No token received. Try again.");
        }
        saveToken(data.access_token);
        pendingDeviceCode = null;
        return {
            content: [
                {
                    type: "text",
                    text: "Logged in successfully. Your credentials are saved — you won't need to log in again.",
                },
            ],
        };
    });
    // ── logout ────────────────────────────────────────────────────────────────
    server.tool("logout", "Clear locally stored PostKing credentials.", {}, async () => {
        deleteToken();
        return {
            content: [
                {
                    type: "text",
                    text: "Logged out. Your local credentials have been removed.",
                },
            ],
        };
    });
}
//# sourceMappingURL=auth.js.map