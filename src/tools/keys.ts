import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

export function registerKeyTools(server: McpServer) {
  // ── List API keys ─────────────────────────────────────────────────────────
  server.tool(
    "list_api_keys",
    "List all API keys on the account. Shows prefix, scope, and revocation status. Does NOT show raw tokens.",
    {},
    async () => {
      const data = await api.get<any>("/api/agent/v1/keys");
      const keys = (data?.keys ?? []).map((k: any) => ({
        id: k.id,
        name: k.clientName ?? k.name ?? "(unnamed)",
        prefix: k.prefix ? `${k.prefix}...` : null,
        scope: k.scope ?? "write",
        status: k.revokedAt ? "revoked" : "active",
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(keys, null, 2) }],
      };
    }
  );

  // ── Create API key ────────────────────────────────────────────────────────
  server.tool(
    "create_api_key",
    [
      "Create a new PostKing API key. The raw token (pk_live_*) is returned ONCE in this response and never shown again.",
      "Store it immediately — treat it like a password. Scope: 'write' (default) or 'read'.",
    ].join(" "),
    {
      name: z.string().optional().default("postking-mcp").describe("Descriptive name for the key"),
      scope: z.enum(["write", "read"]).optional().default("write").describe("Permission scope"),
    },
    async ({ name, scope }) => {
      const data = await api.post<any>("/api/agent/v1/keys", {
        name,
        clientName: name,
        scope,
      });
      const key = data?.key ?? data;
      const token = data?.token;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: key?.id,
                name: key?.name ?? name,
                scope: key?.scope ?? scope,
                token,
                WARNING: "This is the ONLY time the raw token is shown. Store it now.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Revoke API key ────────────────────────────────────────────────────────
  server.tool(
    "revoke_api_key",
    "Permanently revoke an API key. Pass confirm: true to proceed — this is irreversible and any clients using this key will stop working immediately.",
    {
      keyId: z.string().describe("API key ID from list_api_keys"),
      confirm: z.literal(true).describe("Must be true to confirm revocation"),
    },
    async ({ keyId }) => {
      await api.delete(`/api/agent/v1/keys/${keyId}`);
      return {
        content: [{ type: "text" as const, text: `API key ${keyId} revoked.` }],
      };
    }
  );
}
