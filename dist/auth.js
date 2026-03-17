import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const CREDENTIALS_DIR = join(homedir(), ".postking");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
export function loadStoredToken() {
    try {
        const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
        const creds = JSON.parse(raw);
        return creds.token ?? null;
    }
    catch {
        return null;
    }
}
export function saveToken(token) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}
export function deleteToken() {
    try {
        unlinkSync(CREDENTIALS_FILE);
    }
    catch {
        // already gone
    }
}
//# sourceMappingURL=auth.js.map