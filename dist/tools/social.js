import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
function slimAccount(a) {
    return { id: a.id, platform: a.platform, name: a.name ?? a.username, connected: a.connected ?? a.status };
}
export function registerSocialTools(server) {
    server.tool("check_social_accounts", "List all connected and disconnected social accounts for the active brand. Run before posting to confirm platform availability.", { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") }, async ({ brandId }) => {
        const id = requireBrandId(brandId);
        const data = await api.get(`/api/brands/${id}/social-accounts`);
        const slim = Array.isArray(data) ? data.map(slimAccount) : data;
        return {
            content: [{ type: "text", text: JSON.stringify(slim, null, 2) }],
        };
    });
    server.tool("generate_connect_link", "Generate a secure browser link to connect a social media account. Share this URL with the user to complete OAuth.", { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") }, async ({ brandId }) => {
        const id = requireBrandId(brandId);
        const data = await api.post(`/api/brands/${id}/social-accounts/connect-link`);
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
    server.tool("disconnect_social_account", "Disconnect a social account by its account ID.", {
        accountId: z.string().describe("Social account ID to disconnect"),
        brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    }, async ({ accountId, brandId }) => {
        const id = requireBrandId(brandId);
        await api.delete(`/api/brands/${id}/social-accounts/${accountId}`);
        return {
            content: [{ type: "text", text: `Account ${accountId} disconnected.` }],
        };
    });
}
//# sourceMappingURL=social.js.map