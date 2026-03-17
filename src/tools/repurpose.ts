import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

export function registerRepurposeTools(server: McpServer) {
  server.tool(
    "repurpose_content",
    [
      "Turn a URL, text, blog post, or existing PostKing post into new content for social media or blogs.",
      "IMPORTANT: When the source is a URL, pass it directly to this tool via sourceUrl — do NOT fetch or crawl the URL yourself first. PostKing handles all crawling internally.",
      "Source types: url | text | blog | social_post.",
      "Target types: social (LinkedIn, X, etc.) | blog | text.",
    ].join(" "),
    {
      sourceType: z
        .enum(["url", "text", "blog", "social_post"])
        .describe("Where the source content comes from"),
      sourceUrl: z.string().url().optional().describe("URL to repurpose (when sourceType=url)"),
      sourceContent: z.string().optional().describe("Raw text to repurpose (when sourceType=text)"),
      sourcePostId: z
        .string()
        .optional()
        .describe("Existing PostKing post ID (when sourceType=social_post)"),
      targetType: z
        .enum(["social", "blog", "text"])
        .describe("What to generate"),
      targetPlatforms: z
        .array(z.string())
        .optional()
        .describe("Platforms for social output, e.g. ['x','linkedin']"),
      variations: z.number().min(1).max(5).optional().default(1),
      angle: z.string().optional().describe("Specific angle or focus, e.g. 'focus on ROI data'"),
      themeId: z.string().optional().describe("Content theme ID to attach"),
      includeLink: z.boolean().optional().describe("Include source link in output"),
      textLength: z
        .string()
        .optional()
        .describe("For text target: short | medium | long | custom:<words>"),
      voiceProfileIds: z
        .array(z.string())
        .optional()
        .describe("Voice profile IDs. Single ID applies to all platforms: ['clxvoice1']. Per-platform: ['x:clxvoice1','linkedin:clxvoice2']. Get IDs from list_voices."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({
      sourceType,
      sourceUrl,
      sourceContent,
      sourcePostId,
      targetType,
      targetPlatforms,
      variations,
      angle,
      themeId,
      includeLink,
      textLength,
      voiceProfileIds,
      brandId,
    }) => {
      const id = requireBrandId(brandId);

      // Convert array format to Record<platform, profileId> the backend expects.
      // Accepts: ["profileId"] (apply to all platforms) or ["x:id1", "linkedin:id2"]
      let voiceMap: Record<string, string> | undefined;
      if (voiceProfileIds && voiceProfileIds.length > 0) {
        voiceMap = {};
        const platforms = targetPlatforms?.length ? targetPlatforms : (targetType === "text" ? ["text"] : ["x", "linkedin", "instagram", "threads", "facebook"]);
        for (const entry of voiceProfileIds) {
          if (entry.includes(":")) {
            const [platform, profileId] = entry.split(":");
            voiceMap[platform] = profileId;
          } else {
            // No platform prefix — apply to all target platforms
            for (const platform of platforms) {
              voiceMap[platform] = entry;
            }
          }
        }
      }

      const data = await api.post(`/api/brands/${id}/repurpose`, {
        sourceType,
        sourceUrl,
        sourceContent,
        sourcePostId,
        targetType,
        targetPlatforms,
        variationCount: variations,
        angle,
        themeId,
        includeLink,
        textLength,
        voiceProfileIds: voiceMap,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
