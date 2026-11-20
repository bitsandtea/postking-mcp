import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";

type Row = Record<string, unknown>;

function pickKeys(o: Row, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

const SHORT_KEYS = ["accountId", "platform", "type", "handle", "status"];
const MEDIUM_KEYS = [...SHORT_KEYS, "name", "followers", "lastSyncAt", "statusSince", "metricsStatus", "metricsError", "metricsStaleSince"];

/** The route returns { success, accounts: [...] }; tolerate a bare array too. */
function unwrapAccounts(data: unknown): Row[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Row).accounts)
      ? ((data as Row).accounts as unknown[])
      : [];
  return list.filter((a): a is Row => !!a && typeof a === "object");
}

export function registerSocialTools(server: McpServer) {
  server.tool(
    "check_social_accounts",
    [
      "List the brand's social accounts with their health: every active account, INCLUDING ones that need a reconnect (status token_expired | sync_failing | disconnected | session_invalid). Check `status` before posting — only `connected` accounts can publish; for others call generate_connect_link to reconnect.",
      "Returns accountId (use it with social_account_history / social_post_performance), platform, type (personal | company | page), handle, status. detail=medium adds name, followers, lastSyncAt, statusSince, metricsStatus (ok | sync_failing | not_collected: whether post metrics are syncing, separate from `status`) metricsError and metricsStaleSince (when metrics stopped updating, if older than ~30 days); detail=full adds lastError, metricsAvailable (which metrics the platform reports: followers, postImpressions, pageImpressions, pageEngagements), connectedAt and isDefaultForPlatform. For metrics use social_performance.",
    ].join(" "),
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
      detail: detailParam("short"),
    },
    async ({ brandId, detail }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<unknown>(`/api/agent/v1/brands/${id}/social-accounts`);
      const raw = unwrapAccounts(data);
      const proj: Projector<Row> = {
        short: (a) => pickKeys(a, SHORT_KEYS),
        medium: (a) => pickKeys(a, MEDIUM_KEYS),
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
