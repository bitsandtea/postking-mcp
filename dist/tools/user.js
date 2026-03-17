import { api } from "../client.js";
export function registerUserTools(server) {
    server.tool("get_credits", "Check your current PostKing credit balance.", {}, async () => {
        const data = await api.get("/api/user/credits");
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
}
//# sourceMappingURL=user.js.map