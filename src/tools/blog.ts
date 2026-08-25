import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, project, projectList, truncate, type Projector } from "../detail.js";
import { languageParam, SUPPORTED_LANGUAGE_CODES, LANGUAGE_CODE_LIST_TEXT } from "../languages.js";

// LIST tools must never carry article bodies — full bodies overflow small MCP clients.
const HEAVY_ARTICLE_KEYS = ["postText", "postContent", "postContentHtml", "postContentHTML", "postContentMarkdown", "content", "body", "postBody", "bodyHtml"];
function stripHeavy(a: Record<string, unknown>): Record<string, unknown> {
  const c = { ...a };
  for (const k of HEAVY_ARTICLE_KEYS) delete c[k];
  return c;
}

/**
 * Projects an article's CTA state for read-back. `ctas[]` is the column the
 * dashboard editor and the renderer actually read; `sidePageInfo` is the
 * legacy single-CTA mirror the server keeps in sync with it. Both are
 * surfaced so a caller can verify what a `cta`/`sidePageInfo` write landed
 * on instead of having to trust a bare 200.
 */
function projectCtas(a: any) {
  const ctas = Array.isArray(a?.ctas) ? a.ctas : [];
  const spi = a?.sidePageInfo && typeof a.sidePageInfo === "object" ? a.sidePageInfo : null;
  return {
    ctas: ctas.map((c: any) => ({
      id: c?.id,
      anchor: c?.anchor,
      url: c?.ctaHref ?? null,
      label: c?.ctaButtonText ?? null,
      headline: c?.header ?? null,
      body: c?.ctaText ?? null,
      sidePageId: c?.sidePageId ?? null,
      slug: c?.slug ?? null,
      source: c?.ctaSource ?? null,
      style: c?.style ?? "strong",
    })),
    ctaCount: ctas.length,
    sidePageInfo: spi
      ? {
          id: spi.id ?? null,
          slug: spi.slug ?? null,
          headline: spi.header ?? null,
          body: spi.ctaText ?? null,
          label: spi.ctaButtonText ?? null,
          url: spi.ctaHref ?? null,
          source: spi.ctaSource ?? null,
        }
      : null,
  };
}

function slimArticle(a: any) {
  return {
    id: a.id,
    title: a.postTitle ?? a.title,
    status: a.status,
    slug: a.postUrl ?? a.postSlug ?? a.slug,
    excerpt: typeof a.postExcerpt === "string" ? a.postExcerpt.slice(0, 150) : null,
    category: a.category?.name ?? null,
    author: a.author ? `${a.author.authorFirstName} ${a.author.authorLastName}`.trim() : null,
    createdAt: a.createdAt,
    publicationId: a.blogId,
    featuredImageUrl: a.postImage ?? null,
  };
}

/** slimArticle + the article's CTA state — the write-echo shape, so a caller
 * can confirm what a `cta`/`sidePageInfo` write actually persisted. Kept out
 * of slimArticle itself since that also backs list_blogs' per-row projection. */
function slimArticleWithCtas(a: any) {
  return { ...slimArticle(a), ...projectCtas(a) };
}

export function registerBlogTools(server: McpServer) {
  // ── List publications & articles ──────────────────────────────────────────
  server.tool(
    "list_blogs",
    "LIST tool. Even detail='full' OMITS article bodies (kept bounded) — to read an article's content, call get_blog_article. The number of rows is controlled by `limit` (default 50, max 200), NOT by `detail`; for a 'full list' of titles, raise `limit` and keep detail='short'. On a brand publishing in more than one language (see get_brand_languages), publications and articles both carry `languageCode` — check it before generating into a publication, since two publications with the same brand can differ only by language.",
    {
      status: z.enum(["draft", "published"]).optional().describe("Filter articles by status"),
      detail: detailParam("short"),
      limit: z.number().int().min(1).max(200).default(50),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, detail, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/blogs`);
      const rawPubs = (Array.isArray((data as any)?.publications) ? (data as any).publications : []) as Record<string, unknown>[];
      const allArticles = (Array.isArray((data as any)?.blogs) ? (data as any).blogs : []) as Record<string, unknown>[];

      // Compute statusBreakdown over the FULL set before any status filter so the agent always sees the true split
      const statusBreakdown: Record<string, number> = {};
      for (const a of allArticles) {
        const s = typeof a.status === "string" ? a.status : "unknown";
        statusBreakdown[s] = (statusBreakdown[s] ?? 0) + 1;
      }

      // Apply status filter for returned rows
      let filteredArticles = status ? allArticles.filter((a) => a.status === status) : allArticles;
      const total = filteredArticles.length;
      filteredArticles = filteredArticles.slice(0, limit);
      const count = filteredArticles.length;
      const truncated = total > count;

      const pubProj: Projector<Record<string, unknown>> = {
        short: (p) => ({ id: p.id, name: p.title, languageCode: p.languageCode ?? null }),
        medium: (p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          languageCode: p.languageCode ?? null,
          pathPrefix: p.pathPrefix ?? null,
          domain: (p.domain as string | null) ?? null,
          layout: p.layout,
          articleCount: (p._count as Record<string, unknown>)?.blogArticles ?? null,
        }),
      };
      // BlogArticle has no language column of its own — it inherits its
      // language from its parent publication (blogId, exposed here as
      // publicationId). Resolve that locally from the publications array
      // this same response already carries, rather than fabricating or
      // adding a round-trip.
      const pubLangById = new Map<unknown, unknown>(rawPubs.map((p) => [p.id, p.languageCode ?? null]));
      const artProj: Projector<Record<string, unknown>> = {
        short: (a) => ({
          id: a.id,
          title: a.postTitle ?? a.title,
          slug: a.postSlug ?? a.slug,
          status: a.status,
          languageCode: pubLangById.get(a.blogId) ?? null,
        }),
        medium: (a) => ({ ...slimArticle(a), languageCode: pubLangById.get(a.blogId) ?? null }),
      };
      const result: Record<string, unknown> = {
        count,
        total,
        truncated,
        statusBreakdown,
        detail,
        publications: projectList(detail, rawPubs, pubProj),
        articles: detail === "full" ? filteredArticles.map(stripHeavy) : projectList(detail, filteredArticles, artProj),
      };
      if (truncated) {
        result.note = `Showing ${count} of ${total} articles. Pass a higher limit or status filter to see the rest.`;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Create publication ────────────────────────────────────────────────────
  server.tool(
    "create_publication",
    [
      "Create a new blog publication (the container that articles live under). Returns a publicationId needed for generate_blog_post.",
      `Optional languageCode sets this publication's language, as a BCP-47 code — one of: ${LANGUAGE_CODE_LIST_TEXT}. Omit to default to the brand's configured content language. If supplied, it must already be enabled on the brand's language roster (check with get_brand_languages, enable with add_brand_language first) — an un-enabled code is rejected with a 403.`,
    ].join(" "),
    {
      title: z.string().describe("Publication name, e.g. 'My Blog'"),
      description: z.string().optional(),
      layout: z.string().optional(),
      languageCode: z
        .enum(SUPPORTED_LANGUAGE_CODES)
        .optional()
        .describe(
          `Language for this new publication, as a BCP-47 code. One of: ${LANGUAGE_CODE_LIST_TEXT}. Omit to default to the brand's configured content language. Must already be enabled on the brand's language roster (get_brand_languages / add_brand_language) — an un-enabled code returns 403.`
        ),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ title, description, layout, languageCode, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs`, {
        title,
        description,
        layout,
        // Omitted when the caller said nothing, so the server can tell
        // "no override" from an explicit language code (JSON.stringify drops undefined).
        languageCode,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: data.id, title: data.title, languageCode: data.languageCode ?? null }, null, 2) }],
      };
    }
  );

  // ── Update publication ────────────────────────────────────────────────────
  server.tool(
    "update_publication",
    "Update an existing blog publication's metadata — title, description, domain/routing config, or layout. Only the fields you pass are changed (partial update). Distinct from create_publication (which creates a new one). publicationId comes from list_publications or list_blogs.",
    {
      publicationId: z.string().describe("Blog publication ID (from list_publications or list_blogs)"),
      title: z.string().optional(),
      description: z.string().optional().describe("Publication description / tagline"),
      domainId: z.string().optional().describe("Custom domain ID to route this publication under"),
      routingType: z.string().optional(),
      pathPrefix: z.string().optional(),
      layout: z.string().optional(),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, title, description, domainId, routingType, pathPrefix, layout, brandId }) => {
      const id = requireBrandId(brandId);
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (domainId !== undefined) body.domainId = domainId;
      if (routingType !== undefined) body.routingType = routingType;
      if (pathPrefix !== undefined) body.pathPrefix = pathPrefix;
      if (layout !== undefined) body.layout = layout;
      if (Object.keys(body).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields to update. Pass at least one of: title, description, domainId, routingType, pathPrefix, layout." }],
        };
      }
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/publications/${publicationId}`, body);
      const pub = data?.publication ?? data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: pub?.id ?? publicationId, title: pub?.title, description: pub?.description, updated: Object.keys(body) }, null, 2) }],
      };
    }
  );

  // ── Delete publication ────────────────────────────────────────────────────
  server.tool(
    "delete_publication",
    "Permanently delete a blog publication. Only allowed when it has zero articles and no connected domain/external sync/publishing connections — otherwise the API refuses with an explanation of what's still attached (remove/disconnect those first, e.g. delete_blog_article for every article under it).",
    {
      publicationId: z.string().describe("Blog publication ID (from list_publications or list_blogs)"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/publications/${publicationId}`);
      return {
        content: [{ type: "text" as const, text: `Publication ${publicationId} deleted.` }],
      };
    }
  );

  // ── Generate blog post (AI) ───────────────────────────────────────────────
  server.tool(
    "generate_blog_post",
    [
      "Generate a full AI blog article. Requires a publicationId (from list_blogs or create_publication).",
      "Pass a voiceProfileId to write in a specific person's style (IDs from list_voices).",
      "Returns an articleId + operationId; generation is async — poll get_blog_status until completed, then get_blog_article. Use update_blog_article to edit, or publish_blog_article to push to external platforms.",
      "To make it live on your PostKing blog, call update_blog_article with status: 'published'.",
    ].join(" "),
    {
      publicationId: z.string().describe("Blog publication ID"),
      topic: z.string().describe("Topic or working title for the post"),
      voiceProfileId: z.string().optional().describe("Voice profile ID for writing style (from list_voices)"),
      targetLength: z.enum(["short", "medium", "long"]).optional().default("medium"),
      primaryKeywords: z.array(z.string()).optional().describe("SEO keywords to target"),
      secondaryKeywords: z.array(z.string()).optional().describe("Secondary SEO keywords to target"),
      readabilityTarget: z.string().optional().describe("Readability level for the writing, e.g. 'grade-8'"),
      generateAiImage: z.boolean().optional().default(false).describe("Generate an AI header image"),
      imageVariationCount: z.number().int().min(1).max(5).optional().describe("Number of AI image variations to generate (1-5). Only used when generateAiImage is true."),
      attachVisualAsset: z.boolean().optional().describe("Use a brand visual asset (with branding) for the header image"),
      selectedAssetId: z.string().optional().describe("ID of the brand asset to use for the header image"),
      skipBrandContext: z.boolean().optional().describe("Omit brand context from the generation prompt when true"),
      language: languageParam("Applies to this article only; the brand's standing language is set with set_brand_content_language."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, topic, voiceProfileId, targetLength, primaryKeywords, secondaryKeywords, readabilityTarget, generateAiImage, imageVariationCount, attachVisualAsset, selectedAssetId, skipBrandContext, language, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs/generate`, {
        blogId: publicationId,
        topic,
        voiceProfileId,
        targetLength,
        primaryKeywords,
        secondaryKeywords,
        readabilityTarget,
        generateAiImage,
        imageVariationCount,
        attachVisualAsset,
        selectedAssetId,
        skipBrandContext,
        // Dropped from the JSON body when undefined, so "no override" stays
        // distinguishable from an explicit "en" server-side.
        language,
        assignAsset: false,
      });
      const article = data?.blog ?? data?.article ?? null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              articleId: data?.blogId ?? article?.id ?? data?.id ?? null,
              operationId: data?.operationId ?? null,
              pollUrl: data?.pollUrl ?? null,
              status: article?.status ?? "running",
              note: "Generation is async. Poll get_blog_status with the returned articleId until status is completed, then get_blog_article to read the content.",
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── Get blog article ──────────────────────────────────────────────────────
  server.tool(
    "get_blog_article",
    "Fetch a blog article by ID. detail='short' returns id/title/slug/status/languageCode; detail='medium' adds excerpt+wordCount+CTA state+previewUrl+editUrl; detail='full' (default) returns the COMPLETE content plus CTA state, previewUrl (GUI preview link) and editUrl (dashboard editor link). CTA state is `ctas[]` (the ordered list the dashboard editor and the public renderer read) plus `sidePageInfo` (the legacy single-CTA mirror) — use it to verify what an update_blog_article `cta` write persisted. languageCode is inherited from the article's parent publication (BlogArticle has no language column of its own) and may be null on a publication created before multi-language support was added. Pass maxContentChars only if you need to bound the body size; omit it to get the whole article.",
    {
      articleId: z.string().describe("Blog article ID"),
      detail: detailParam("full"),
      maxContentChars: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe("Optional cap on the returned content body length (full detail only). Omit to return the ENTIRE article body. Use only to bound payload size for small clients."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, detail, maxContentChars, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/blogs/${articleId}`);
      // The agent endpoint nests the article under `blog`; the GUI preview URL is
      // at blog.previewUrl and the dashboard edit URL is the envelope's webUrl.
      const a = ((data as any)?.blog ?? (data as any)?.article ?? data) as Record<string, unknown>;
      const editUrl = typeof (data as any)?.webUrl === "string" ? (data as any).webUrl : null;
      const previewUrl = typeof a.previewUrl === "string" ? a.previewUrl : null;

      const buildFullArticle = (a: Record<string, unknown>) => {
        const fullText = typeof a.postText === "string" ? a.postText : null;
        const contentTruncated =
          fullText !== null && typeof maxContentChars === "number" && fullText.length > maxContentChars;
        const content = contentTruncated ? fullText!.slice(0, maxContentChars) + "…" : fullText;
        return {
          id: a.id,
          title: a.postTitle,
          status: a.status,
          slug: a.postUrl ?? a.postSlug ?? a.slug,
          languageCode: a.languageCode ?? null,
          excerpt: a.postExcerpt,
          content,
          contentLength: fullText !== null ? fullText.length : null,
          ...(contentTruncated
            ? { contentTruncated: true, note: `Content truncated to ${maxContentChars} of ${fullText!.length} chars. Re-call without maxContentChars (or with a higher value) to get the full body.` }
            : {}),
          metaTitle: a.postMetaTitle,
          metaDescription: a.postMetaDescription,
          featuredImageUrl: a.postImage ?? null,
          featuredImageAlt: a.postImageAlt ?? null,
          featuredImageDescription: a.postImageDesc ?? null,
          category: (a.category as Record<string, unknown>)?.name ?? null,
          author: a.author
            ? `${(a.author as Record<string, unknown>).authorFirstName} ${(a.author as Record<string, unknown>).authorLastName}`.trim()
            : null,
          publicationId: a.blogId,
          ...projectCtas(a),
          previewUrl,
          editUrl,
        };
      };

      const proj: Projector<Record<string, unknown>> = {
        short: (a) => ({ id: a.id, title: a.postTitle, slug: a.postUrl ?? a.postSlug ?? a.slug, status: a.status, languageCode: a.languageCode ?? null }),
        medium: (a) => ({
          id: a.id,
          title: a.postTitle,
          slug: a.postUrl ?? a.postSlug ?? a.slug,
          status: a.status,
          languageCode: a.languageCode ?? null,
          excerpt: truncate(a.postText, 300),
          wordCount: typeof a.postText === "string" ? a.postText.split(/\s+/).length : null,
          ...projectCtas(a),
          previewUrl,
          editUrl,
        }),
      };
      const result = detail === "full" ? buildFullArticle(a) : project(detail, a, proj);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Update blog article ───────────────────────────────────────────────────
  server.tool(
    "update_blog_article",
    [
      "Edit a blog article — title, content, excerpt, SEO fields, status, author, category, featured/header image, or CTA. Set status='published' to make it live on your PostKing blog.",
      "CTA (call-to-action) is structured data, NOT part of the article body — never write CTA markup into `content`.",
      "Use `cta: { url, label, headline, body }` to set it (url is required when enabling), or `cta: { enabled: false }` to remove it.",
      "`cta` and `sidePageInfo` are mutually exclusive — pass `sidePageInfo` only if you need to link to an existing side page by id/slug (from list_side_pages) instead of a raw url; either way, malformed CTA shapes are now rejected by the server rather than silently persisted, so pass exactly the documented fields.",
      "`cta` is a PARTIAL patch: fields you omit keep their current values. The response echoes back the article's resulting `ctas[]` (the list the dashboard editor renders) plus the legacy `sidePageInfo` mirror — read those to confirm what was saved instead of relying on the 200 alone. An article may hold several CTAs; `cta`/`sidePageInfo` edit the end-anchored one (or the last one), leaving the rest untouched.",
    ].join(" "),
    {
      articleId: z.string().describe("Blog article ID"),
      title: z.string().optional(),
      content: z.string().optional().describe("Full post body (HTML or markdown). Do not put CTA content here — use the `cta` field."),
      excerpt: z.string().optional(),
      status: z.enum(["draft", "published"]).optional().describe("'published' makes it live on your blog"),
      metaTitle: z.string().optional(),
      metaDescription: z.string().optional(),
      authorId: z.string().optional().describe("Author ID (from list_blog_authors)"),
      categoryId: z.string().optional().describe("Category ID (from list_blog_categories)"),
      featuredImageUrl: z.string().optional().describe("The header/featured image — pass an image URL, a brand-asset URL (the `fileUrl` from list_assets — an absolute CDN URL, e.g. https://cdn.postking.app/assets/<brandId>/...), or a data: URI; bare legacy /assets/... paths are still accepted as input; external URLs are auto-downloaded when the article is published; pass an empty string to remove the current image."),
      featuredImageAlt: z.string().optional().describe("Alt text for the featured/header image"),
      featuredImageDescription: z.string().optional().describe("Description/caption for the featured/header image"),
      cta: z
        .object({
          enabled: z.boolean().optional().describe("Set to false to remove the CTA."),
          url: z.string().optional().describe("CTA link target. Required unless enabled is false."),
          label: z.string().optional().describe("CTA button text."),
          headline: z.string().optional().describe("CTA block headline."),
          body: z.string().optional().describe("CTA block body copy."),
        })
        .strict()
        .optional()
        .describe("Set or clear the article's CTA block. Mutually exclusive with sidePageInfo."),
      sidePageInfo: z
        .object({
          id: z.string().nullable().optional().describe("Link the CTA to an existing side page by id (from list_side_pages)."),
          name: z.string().optional(),
          slug: z.string().optional(),
          header: z.string().optional(),
          ctaText: z.string().optional(),
          ctaButtonText: z.string().optional(),
          ctaHref: z.string().optional(),
          ctaSource: z.string().optional(),
        })
        .strict()
        .nullable()
        .optional()
        .describe("Full CTA object (advanced). Must include at least one of id/slug/ctaHref. Pass null to clear the CTA. Mutually exclusive with cta."),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, title, content, excerpt, status, metaTitle, metaDescription, authorId, categoryId, featuredImageUrl, featuredImageAlt, featuredImageDescription, cta, sidePageInfo, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, {
        postTitle: title,
        postText: content,
        postExcerpt: excerpt,
        status,
        postMetaTitle: metaTitle,
        postMetaDescription: metaDescription,
        authorId,
        categoryId,
        postImage: featuredImageUrl,
        postImageAlt: featuredImageAlt,
        postImageDesc: featuredImageDescription,
        cta,
        sidePageInfo,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimArticleWithCtas(data?.blog ?? data?.article ?? data), null, 2) }],
      };
    }
  );

  // ── Schedule blog article ─────────────────────────────────────────────────
  server.tool(
    "schedule_blog_article",
    "Schedule an existing blog article to auto-publish at a future date/time. scheduledAt must be a future ISO 8601 datetime. When the time arrives, the article publishes to the PostKing blog and auto-pushes to any connected external platforms flagged autoPublish. To publish immediately instead, use update_blog_article with status='published'.",
    {
      articleId: z.string().describe("Blog article ID"),
      scheduledAt: z.string().datetime().describe("ISO 8601 datetime in the future, e.g. 2026-07-10T14:30:00Z, when the article should auto-publish"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, scheduledAt, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, {
        status: "scheduled",
        scheduledAt,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimArticle(data?.blog ?? data?.article ?? data), null, 2) }],
      };
    }
  );

  // ── Delete blog article ───────────────────────────────────────────────────
  server.tool(
    "delete_blog_article",
    "Permanently delete a blog article.",
    {
      articleId: z.string().describe("Blog article ID"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      await api.delete(`/api/agent/v1/brands/${id}/blogs/${articleId}`);
      return {
        content: [{ type: "text" as const, text: `Article ${articleId} deleted.` }],
      };
    }
  );

  // ── List authors ──────────────────────────────────────────────────────────
  server.tool(
    "list_blog_authors",
    "List all blog authors for the active brand. Returns id+name by default (short); use detail='medium' for email/social links. Author IDs can be passed to generate_blog_post or update_blog_article.",
    {
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/authors`);
      const rawAuthors = (Array.isArray((data as any)?.authors) ? (data as any).authors : []) as Record<string, unknown>[];
      const proj: Projector<Record<string, unknown>> = {
        short: (a) => ({ id: a.id, name: `${a.authorFirstName} ${a.authorLastName}`.trim() }),
        medium: (a) => ({
          id: a.id,
          name: `${a.authorFirstName} ${a.authorLastName}`.trim(),
          email: a.authorEmail,
          linkedin: a.authorLinkedin,
          twitter: a.authorTwitter,
        }),
      };
      const result = { count: rawAuthors.length, detail, authors: projectList(detail, rawAuthors, proj) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── List categories ───────────────────────────────────────────────────────
  server.tool(
    "list_blog_categories",
    "List all categories for a blog publication. Returns id+name+slug by default (short); use detail='medium' for description+articleCount.",
    {
      publicationId: z.string().describe("Blog publication ID (from list_blogs)"),
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/blogs/${publicationId}/categories`);
      const rawCategories = ((data as any)?.categories ?? (Array.isArray(data) ? data : [])) as Record<string, unknown>[];
      const proj: Projector<Record<string, unknown>> = {
        short: (c) => ({ id: c.id, name: c.name, slug: c.slug }),
        medium: (c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          articleCount: (c._count as Record<string, unknown>)?.blogArticles ?? c.articleCount ?? null,
        }),
      };
      const result = { count: rawCategories.length, detail, categories: projectList(detail, rawCategories, proj) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Create category ───────────────────────────────────────────────────────
  server.tool(
    "create_blog_category",
    "Create a new category in a blog publication.",
    {
      publicationId: z.string().describe("Blog publication ID"),
      name: z.string().describe("Category name"),
      slug: z.string().describe("URL slug, e.g. 'marketing-tips'"),
      description: z.string().optional(),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, name, slug, description, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs/${publicationId}/categories`, { name, slug, description });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── List publishing connections ───────────────────────────────────────────
  server.tool(
    "list_publishing_connections",
    "List external publishing connections for a blog publication (WordPress, Medium, Substack, etc.).",
    {
      publicationId: z.string().describe("Blog publication ID"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/publications/${publicationId}/connections`);
      const connections = Array.isArray(data) ? data : (data?.connections ?? []);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              connections.map((c: any) => ({ id: c.id, platform: c.platform, label: c.label, autoPublish: c.autoPublish })),
              null, 2
            ),
          },
        ],
      };
    }
  );

  // ── Publish to external platforms ─────────────────────────────────────────
  server.tool(
    "publish_blog_article",
    "Push a blog article to connected external platforms (WordPress, Medium, Substack, etc.). Get connection IDs from list_publishing_connections.",
    {
      articleId: z.string().describe("Blog article ID"),
      connectionIds: z.array(z.string()).describe("Connection IDs to publish to"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, connectionIds, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}/publish`, { connectionIds });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Import articles from external blog ────────────────────────────────────
  server.tool(
    "import_blog_articles",
    "Import articles from an external blog, RSS feed, or Blogger URL into a PostKing publication as drafts. Returns id+title+slug by default (short); use detail='medium' for wordCount. Inspect individual articles with get_blog_article.",
    {
      publicationId: z.string().describe("Blog publication ID to import into"),
      sourceUrl: z.string().url().describe("URL of the blog or RSS feed"),
      limit: z.number().min(1).max(200).optional().default(20),
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, sourceUrl, limit, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<Record<string, unknown>>(`/api/agent/v1/brands/${id}/publications/${publicationId}/import`, { sourceUrl, limit });
      const arr = (Array.isArray((data as any)?.articles) ? (data as any).articles : []) as Record<string, unknown>[];
      const artProj: Projector<Record<string, unknown>> = {
        short: (a) => ({ id: a.id, title: a.postTitle ?? a.title, slug: a.postSlug ?? a.slug }),
        medium: (a) => ({ id: a.id, title: a.postTitle ?? a.title, slug: a.postSlug ?? a.slug, wordCount: (a.wordCount as number | null) ?? null }),
      };
      const result = { imported: (data as any)?.imported, failed: (data as any)?.failed, detail, articles: projectList(detail, arr, artProj) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── Get blog generation status ────────────────────────────────────────────
  server.tool(
    "get_blog_status",
    "Poll the async generation status of a blog article. Use the articleId returned by generate_blog_post. Status: pending | running | completed | failed.",
    {
      articleId: z.string().describe("Blog article ID returned by generate_blog_post"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}/status`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Create blog author ────────────────────────────────────────────────────
  server.tool(
    "create_blog_author",
    "Create a new author for blog articles. Returns an authorId that can be used in generate_blog_post and update_blog_article.",
    {
      firstName: z.string().describe("Author first name"),
      lastName: z.string().describe("Author last name"),
      email: z.string().optional().describe("Author email address"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ firstName, lastName, email, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/authors`, {
        authorFirstName: firstName,
        authorLastName: lastName,
        authorEmail: email,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── List publications ─────────────────────────────────────────────────────
  server.tool(
    "list_publications",
    "List all blog publications (the containers that blog articles live under). detail='short' returns id+name+languageCode; detail='medium' adds pathPrefix; detail='full' returns raw rows. On a brand publishing in more than one language (see get_brand_languages), languageCode is how you tell same-brand publications apart. Distinct from list_publishing_connections which lists external platforms like WordPress.",
    {
      detail: detailParam("short"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ detail, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/blogs`);
      const rawPubs = (Array.isArray((data as any)?.publications) ? (data as any).publications : []) as Record<string, unknown>[];
      const proj: Projector<Record<string, unknown>> = {
        short: (p) => ({ id: p.id, name: p.title, languageCode: p.languageCode ?? null }),
        medium: (p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          languageCode: p.languageCode ?? null,
          pathPrefix: p.pathPrefix ?? null,
          domain: (p.domain as string | null) ?? null,
          layout: p.layout,
          articleCount: (p._count as Record<string, unknown>)?.blogArticles ?? null,
        }),
      };
      const result = { count: rawPubs.length, detail, publications: projectList(detail, rawPubs, proj) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ── SEO roadmap ───────────────────────────────────────────────────────────
  server.tool(
    "get_seo_roadmap",
    "View the SEO / GEO content roadmap — suggested blog topics, keywords, and completion status. detail='short' returns stats only; detail='medium' adds slim item list (id+title+status+keyword); detail='full' (default) returns raw response.",
    {
      status: z.enum(["suggested", "in_progress", "completed", "ignored"]).optional().describe("Filter by status"),
      detail: detailParam("full"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = status ? `?status=${status}` : "";
      const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/seo/roadmap${qs}`);
      let result: unknown;
      if (detail === "short") {
        result = { stats: data?.stats };
      } else if (detail === "medium") {
        const items = (Array.isArray((data as any)?.items) ? (data as any).items : []) as Record<string, unknown>[];
        result = {
          stats: data?.stats,
          count: items.length,
          items: items.map((item) => ({
            id: item.id,
            title: item.title,
            type: item.itemType,
            priority: item.priority,
            status: item.status,
            keyword: item.primaryKeyword,
          })),
        };
      } else {
        result = data;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );
}
