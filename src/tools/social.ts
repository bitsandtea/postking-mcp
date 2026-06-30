import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";

function slimAccount(a: any) {
  return { id: a.id, platform: a.platform, name: a.name ?? a.username, connected: a.connected ?? a.status };
}

export function registerSocialTools(server: McpServer) {
  server.tool(
    "check_social_accounts",
    "List all connected and disconnected social accounts for the active brand. Lists default short; pass detail=medium/full for more fields. Run before posting to confirm platform availability.",
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("short"),
    },
    async ({ brandId, detail }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown[]>(`/api/agent/v1/brands/${id}/social-accounts`);
      const raw = Array.isArray(data) ? data : [];
      const proj: Projector<unknown> = {
        short: (a) => ({
          id: (a as any).id,
          platform: (a as any).platform,
          connected: (a as any).connected ?? (a as any).status,
        }),
        medium: (a) => slimAccount(a as any),
      };
      const text = JSON.stringify({ count: raw.length, detail, accounts: projectList(detail, raw, proj) });
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "generate_connect_link",
    "Generate a secure browser link to connect a social media account. Share this URL with the user to complete OAuth.",
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      platform: z
        .enum(["linkedin", "x", "instagram", "threads", "facebook", "tiktok", "youtube"])
        .optional()
        .describe("Target social platform for the connect link"),
    },
    async ({ brandId, platform }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (platform) body.platform = platform;
      const data = await api.post(
        `/api/agent/v1/brands/${id}/social-accounts/connect-link`,
        body
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "disconnect_social_account",
    "Disconnect a social account by its account ID.",
    {
      accountId: z.string().describe("Social account ID to disconnect"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ accountId, brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/social-accounts/${accountId}`);
      return {
        content: [{ type: "text" as const, text: `Account ${accountId} disconnected.` }],
      };
    }
  );
}
