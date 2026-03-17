import { z } from "zod";
import { api } from "../client.js";
import { pollUntilDone } from "../poll.js";
import { requireBrandId, setActiveBrandId, getActiveBrandId } from "../state.js";
function slimBrand(b) {
    return { id: b.id, name: b.name, website: b.website, description: b.description };
}
function slimTheme(t) {
    return { id: t.id, title: t.title, content: typeof t.content === "string" ? t.content.slice(0, 200) : t.content };
}
export function registerBrandTools(server) {
    // ── List brands ──────────────────────────────────────────────────────────
    server.tool("list_brands", "List all brands on your PostKing account. Call this first to discover brandIds.", {}, async () => {
        const data = await api.get("/api/brands");
        const raw = Array.isArray(data) ? data : (data.brands ?? [data]);
        const brands = raw.map(slimBrand);
        const active = getActiveBrandId();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ activeBrandId: active, brands }, null, 2),
                },
            ],
        };
    });
    // ── Set active brand ──────────────────────────────────────────────────────
    server.tool("set_active_brand", "Set the active brand for this session. All subsequent tools will use this brand by default.", { brandId: z.string().describe("The brand ID to activate") }, async ({ brandId }) => {
        setActiveBrandId(brandId);
        return {
            content: [
                {
                    type: "text",
                    text: `Active brand set to: ${brandId}`,
                },
            ],
        };
    });
    // ── Get brand info ────────────────────────────────────────────────────────
    server.tool("get_brand_info", "Get the full profile of a brand — tone, audience, themes, social accounts, and more.", { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") }, async ({ brandId }) => {
        const id = requireBrandId(brandId);
        const data = await api.get(`/api/brands/${id}`);
        const { audienceData, operationStatus, themes, blogArticles, ...slim } = data ?? {};
        return {
            content: [{ type: "text", text: JSON.stringify(slim, null, 2) }],
        };
    });
    // ── Create brand ──────────────────────────────────────────────────────────
    server.tool("create_brand", "Manually create a new brand without automatic website crawling.", {
        name: z.string().describe("Brand name"),
        tone: z.string().optional().describe("Writing tone, e.g. 'Bold & Direct'"),
        audience: z.string().optional().describe("Target audience description"),
        website: z.string().url().optional().describe("Website URL"),
        description: z.string().optional().describe("Brand description"),
    }, async (args) => {
        const data = await api.post("/api/brands", args);
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
    // ── Onboard brand from website ────────────────────────────────────────────
    server.tool("onboard_brand", "Crawl a website and automatically generate a brand profile with 10 content themes. Sets the new brand as active.", {
        websiteUrl: z.string().url().describe("The website to crawl and analyze"),
        name: z.string().optional().describe("Brand name (inferred from site if omitted)"),
    }, async ({ websiteUrl, name }) => {
        const data = await api.post("/api/agent/v1/brands/onboard", {
            websiteUrl,
            name,
        });
        if (data.brandId)
            setActiveBrandId(data.brandId);
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
    // ── List themes ───────────────────────────────────────────────────────────
    server.tool("list_themes", "List all content themes for the active brand with their IDs.", { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") }, async ({ brandId }) => {
        const id = requireBrandId(brandId);
        const data = await api.get(`/api/brands/${id}/themes`);
        const slim = Array.isArray(data) ? data.map(slimTheme) : data;
        return {
            content: [{ type: "text", text: JSON.stringify(slim, null, 2) }],
        };
    });
    // ── Edit theme ────────────────────────────────────────────────────────────
    server.tool("edit_theme", "Edit an existing content theme's title or content instructions.", {
        themeId: z.string().describe("Theme ID to edit"),
        title: z.string().optional().describe("New title for the theme"),
        content: z.string().optional().describe("New content instructions for the theme"),
        brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    }, async ({ themeId, title, content, brandId }) => {
        const id = requireBrandId(brandId);
        const data = await api.patch(`/api/brands/${id}/themes/${themeId}`, { title, content });
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
    // ── Delete theme ──────────────────────────────────────────────────────────
    server.tool("delete_theme", "Delete a content theme from the active brand.", {
        themeId: z.string().describe("Theme ID to delete"),
        brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    }, async ({ themeId, brandId }) => {
        const id = requireBrandId(brandId);
        await api.delete(`/api/brands/${id}/themes/${themeId}`);
        return {
            content: [{ type: "text", text: `Theme ${themeId} deleted.` }],
        };
    });
    // ── Generate themes ───────────────────────────────────────────────────────
    server.tool("generate_themes", "Generate new content themes using AI. Polls until complete. Deducts credits.", {
        count: z.number().min(1).max(20).optional().default(5).describe("Number of themes to generate"),
        instructions: z.string().optional().describe("Custom instructions, e.g. 'Focus on startup growth'"),
        input: z.string().optional().describe("Source text or file path to derive themes from"),
        brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    }, async ({ count, instructions, input, brandId }) => {
        const id = requireBrandId(brandId);
        await api.post(`/api/brands/${id}/themes/generate/async`, {
            count,
            instructions,
            input,
        });
        // Poll brand until theme generation is complete
        await pollUntilDone(`/api/brands/${id}`);
        // Fetch the freshly generated themes
        const themes = await api.get(`/api/brands/${id}/themes`);
        const slim = Array.isArray(themes) ? themes.map(slimTheme) : themes;
        return {
            content: [{ type: "text", text: JSON.stringify(slim, null, 2) }],
        };
    });
}
//# sourceMappingURL=brand.js.map