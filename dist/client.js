import { config, requireToken } from "./config.js";
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}
async function request(method, path, body) {
    const token = requireToken();
    const url = `${config.apiUrl}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            const json = (await res.json());
            message = json.error ?? json.message ?? message;
        }
        catch {
            // ignore
        }
        if (res.status === 401)
            throw new ApiError(401, "Not authenticated. Check your POSTKING_API_TOKEN.");
        if (res.status === 402)
            throw new ApiError(402, `Insufficient credits: ${message}`);
        if (res.status === 403)
            throw new ApiError(403, `Access denied: ${message}`);
        if (res.status === 404)
            throw new ApiError(404, `Not found: ${message}`);
        throw new ApiError(res.status, message);
    }
    return res.json();
}
export const api = {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
};
//# sourceMappingURL=client.js.map