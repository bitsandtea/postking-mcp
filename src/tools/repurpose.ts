import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, type Projector } from "../detail.js";
import { languageParam } from "../languages.js";

// The server response nests generated content under `saved` — `saved.posts` for
// social targets, `saved.blog` for blog targets. There is no top-level `posts`
// key, and `variations` is a platform-keyed object (Record<platform, ...>), not
// an array — so it must never be treated as a list of posts.
function getSavedPosts(data: Record<string, unknown>): Record<string, unknown>[] {
  const saved = data.saved as Record<string, unknown> | undefined;
  return Array.isArray(saved?.posts) ? (saved.posts as Record<string, unknown>[]) : [];
}

function getSavedBlog(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const saved = data.saved as Record<string, unknown> | undefined;
  return saved?.blog as Record<string, unknown> | undefined;
}

const socialProjector: Projector<Record<string, unknown>> = {
  short: (data) => {
    const posts = getSavedPosts(data);
    return { targetType: "social", postIds: posts.map((p) => p.id) };
  },
  medium: (data) => {
    const posts = getSavedPosts(data);
    return {
      targetType: "social",
      variations: posts.map((p) => ({ id: p.id, platform: p.platform, content: p.content })),
    };
  },
};

const blogProjector: Projector<Record<string, unknown>> = {
  short: (data) => {
    const blog = getSavedBlog(data);
    return { targetType: "blog", articleId: blog?.id ?? null, blogId: blog?.blogId ?? null };
  },
  medium: (data) => {
    const blog = getSavedBlog(data);
    return {
      targetType: "blog",
      articleId: blog?.id ?? null,
      blogId: blog?.blogId ?? null,
      title: blog?.postTitle ?? null,
    };
  },
};

// targetType "text" has no `saved` posts/blog — the generated copy lives in the
// same platform-keyed `variations` object as social output, so it gets its own
// projector rather than being squeezed into socialProjector's post-array shape.
const textProjector: Projector<Record<string, unknown>> = {
  short: (data) => ({ targetType: "text", variations: data.variations ?? null }),
  medium: (data) => ({ targetType: "text", variations: data.variations ?? null }),
};

export function registerRepurposeTools(server: McpServer) {
  server.tool(
    "repurpose_content",
    [
      "Turn a URL, text, blog post, or existing PostKing post into new content for social media or blogs.",
      "IMPORTANT: When the source is a URL, pass it directly to this tool via sourceUrl — do NOT fetch or crawl the URL yourself first. PostKing handles all crawling internally.",
      "Source types: url | text | blog | social_post.",
      "Target types: social (LinkedIn, X, etc.) | blog | text.",
      "When targetType is 'blog', pass publicationId to choose which blog publication the generated article is filed under (ids from list_publications) — omit to fall back to the brand's default publication for the content's language.",
      "Supports detail param: short=ids only, medium=key fields (default), full=raw response.",
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
      sourceBlogId: z.string().optional().describe("Existing PostKing blog article ID (when sourceType=blog). Get IDs from list_blogs."),
      targetType: z
        .enum(["social", "blog", "text"])
        .describe("What to generate"),
      publicationId: z
        .string()
        .optional()
        .describe(
          "Which blog publication the generated article is filed under. Only used when targetType is 'blog' — ignored otherwise. Omit to use the brand's default publication for the content's language. Ids come from list_publications."
        ),
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
      language: languageParam("The repurposed output is written in this language regardless of the source language."),
      detail: detailParam("medium"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({
      sourceType,
      sourceUrl,
      sourceContent,
      sourcePostId,
      sourceBlogId,
      targetType,
      targetPlatforms,
      variations,
      angle,
      themeId,
      includeLink,
      textLength,
      voiceProfileIds,
      language,
      publicationId,
      detail,
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

      const raw = await api.post(`/api/agent/v1/tools/repurpose`, {
        brandId: id,
        sourceType,
        sourceUrl,
        sourceContent,
        sourcePostId,
        sourceBlogId,
        targetType,
        targetPlatforms,
        variationCount: variations,
        angle,
        themeId,
        includeLink,
        textLength,
        voiceProfileIds: voiceMap,
        // Omitted (not defaulted) when unset, so the brand default still wins.
        language,
        // Only meaningful when targetType is "blog"; harmless no-op otherwise.
        publicationId,
      });

      const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

      // `variations` is present on every response regardless of target (it's the
      // platform-keyed generation object), so it can't disambiguate the branch —
      // metadata.targetType is the actual signal. Fall back to shape-sniffing
      // `saved.blog` only if metadata is ever missing.
      const metadata = data.metadata as Record<string, unknown> | undefined;
      const responseTargetType =
        (metadata?.targetType as string | undefined) ??
        (getSavedBlog(data) ? "blog" : "social");

      let result: unknown;
      if (detail === "full") {
        // `sourceContent` (the full source text, can be tens of KB) and
        // `originalVariations` are raw generation inputs/intermediates — not
        // useful to the caller and wasteful to return even at full detail.
        const { sourceContent: _sourceContent, originalVariations: _originalVariations, ...rest } = data;
        result = rest;
      } else if (responseTargetType === "blog") {
        result = project(detail, data, blogProjector);
      } else if (responseTargetType === "text") {
        result = project(detail, data, textProjector);
      } else {
        result = project(detail, data, socialProjector);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );
}
