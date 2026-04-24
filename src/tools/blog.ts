import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

function slimArticle(a: any) {
  return {
    id: a.id,
    title: a.postTitle ?? a.title,
    status: a.status,
    slug: a.postSlug ?? a.slug,
    excerpt: typeof a.postExcerpt === "string" ? a.postExcerpt.slice(0, 150) : null,
    category: a.category?.name ?? null,
    author: a.author ? `${a.author.authorFirstName} ${a.author.authorLastName}`.trim() : null,
    createdAt: a.createdAt,
    publicationId: a.blogId,
  };
}

export function registerBlogTools(server: McpServer) {
  // ── List publications & articles ──────────────────────────────────────────
  server.tool(
    "list_blogs",
    "List all blog publications and their articles for the active brand. Publications are the hosting configs; articles are individual posts.",
    {
      status: z.enum(["draft", "published"]).optional().describe("Filter articles by status"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/blogs`);
      const publications = (data?.publications ?? []).map((p: any) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        domain: p.domain ?? null,
        layout: p.layout,
        articleCount: p._count?.blogArticles ?? null,
      }));
      let articles = (data?.blogs ?? []).map(slimArticle);
      if (status) articles = articles.filter((a: any) => a.status === status);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ publications, articles }, null, 2) }],
      };
    }
  );

  // ── Create publication ────────────────────────────────────────────────────
  server.tool(
    "create_publication",
    "Create a new blog publication (the container that articles live under). Returns a publicationId needed for generate_blog_post.",
    {
      title: z.string().describe("Publication name, e.g. 'My Blog'"),
      description: z.string().optional(),
      layout: z.string().optional(),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ title, description, layout, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs`, { title, description, layout });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: data.id, title: data.title }, null, 2) }],
      };
    }
  );

  // ── Generate blog post (AI) ───────────────────────────────────────────────
  server.tool(
    "generate_blog_post",
    [
      "Generate a full AI blog article. Requires a publicationId (from list_blogs or create_publication).",
      "Pass a voiceProfileId to write in a specific person's style (IDs from list_voices).",
      "Returns an articleId. Use update_blog_article to edit, or publish_blog_article to push to external platforms.",
      "To make it live on your PostKing blog, call update_blog_article with status: 'published'.",
    ].join(" "),
    {
      publicationId: z.string().describe("Blog publication ID"),
      topic: z.string().describe("Topic or working title for the post"),
      voiceProfileId: z.string().optional().describe("Voice profile ID for writing style (from list_voices)"),
      targetLength: z.enum(["short", "medium", "long"]).optional().default("medium"),
      primaryKeywords: z.array(z.string()).optional().describe("SEO keywords to target"),
      generateAiImage: z.boolean().optional().default(false).describe("Generate an AI header image"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, topic, voiceProfileId, targetLength, primaryKeywords, generateAiImage, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/blogs/generate`, {
        clusterId: publicationId,
        topic,
        voiceProfileId,
        targetLength,
        primaryKeywords,
        generateAiImage,
        assignAsset: false,
      });
      const article = data?.article ?? data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              articleId: article?.id,
              title: article?.postTitle,
              status: article?.status,
              slug: article?.postSlug,
              wordCount: data?.wordCount,
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── Get blog article ──────────────────────────────────────────────────────
  server.tool(
    "get_blog_article",
    "Fetch the full content of a blog article by ID.",
    {
      articleId: z.string().describe("Blog article ID"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`);
      const a = data?.article ?? data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: a.id,
              title: a.postTitle,
              status: a.status,
              slug: a.postSlug,
              excerpt: a.postExcerpt,
              content: typeof a.postText === "string" ? a.postText.slice(0, 3000) : a.postText,
              metaTitle: a.postMetaTitle,
              metaDescription: a.postMetaDescription,
              category: a.category?.name ?? null,
              author: a.author ? `${a.author.authorFirstName} ${a.author.authorLastName}`.trim() : null,
              publicationId: a.blogId,
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── Update blog article ───────────────────────────────────────────────────
  server.tool(
    "update_blog_article",
    "Edit a blog article — title, content, excerpt, SEO fields, status, author, or category. Set status='published' to make it live on your PostKing blog.",
    {
      articleId: z.string().describe("Blog article ID"),
      title: z.string().optional(),
      content: z.string().optional().describe("Full post body (HTML or markdown)"),
      excerpt: z.string().optional(),
      status: z.enum(["draft", "published"]).optional().describe("'published' makes it live on your blog"),
      metaTitle: z.string().optional(),
      metaDescription: z.string().optional(),
      authorId: z.string().optional().describe("Author ID (from list_blog_authors)"),
      categoryId: z.string().optional().describe("Category ID (from list_blog_categories)"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ articleId, title, content, excerpt, status, metaTitle, metaDescription, authorId, categoryId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.put<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, {
        postTitle: title,
        postText: content,
        postExcerpt: excerpt,
        status,
        postMetaTitle: metaTitle,
        postMetaDescription: metaDescription,
        authorId,
        categoryId,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(slimArticle(data?.article ?? data), null, 2) }],
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
    "List all blog authors for the active brand. Author IDs can be passed to generate_blog_post or update_blog_article.",
    { brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)") },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/authors`);
      const authors = (data?.authors ?? []).map((a: any) => ({
        id: a.id,
        name: `${a.authorFirstName} ${a.authorLastName}`.trim(),
        email: a.authorEmail,
        linkedin: a.authorLinkedin,
        twitter: a.authorTwitter,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(authors, null, 2) }],
      };
    }
  );

  // ── List categories ───────────────────────────────────────────────────────
  server.tool(
    "list_blog_categories",
    "List all categories for a blog publication.",
    {
      publicationId: z.string().describe("Blog publication ID (from list_blogs)"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/blogs/${publicationId}/categories`);
      const categories = (data?.categories ?? (Array.isArray(data) ? data : [])).map((c: any) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        articleCount: c._count?.blogArticles ?? c.articleCount ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(categories, null, 2) }],
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
    "Import articles from an external blog, RSS feed, or Blogger URL into a PostKing publication as drafts.",
    {
      publicationId: z.string().describe("Blog publication ID to import into"),
      sourceUrl: z.string().url().describe("URL of the blog or RSS feed"),
      limit: z.number().min(1).max(200).optional().default(20),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ publicationId, sourceUrl, limit, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/publications/${publicationId}/import`, { sourceUrl, limit });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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
    "List all blog publications (the containers that blog articles live under). Distinct from list_publishing_connections which lists external platforms like WordPress.",
    {
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/blogs`);
      const publications = (data?.publications ?? []).map((p: any) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        domain: p.domain ?? null,
        layout: p.layout,
        articleCount: p._count?.blogArticles ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(publications, null, 2) }],
      };
    }
  );

  // ── SEO roadmap ───────────────────────────────────────────────────────────
  server.tool(
    "get_seo_roadmap",
    "View the SEO content roadmap — suggested blog topics, keywords, and completion status.",
    {
      status: z.enum(["suggested", "in_progress", "completed", "ignored"]).optional().describe("Filter by status"),
      brandId: z.string().optional().describe("Brand ID (uses active brand if omitted)"),
    },
    async ({ status, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = status ? `?status=${status}` : "";
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/seo/roadmap${qs}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stats: data?.stats,
              items: (data?.items ?? []).slice(0, 50).map((item: any) => ({
                id: item.id,
                title: item.title,
                type: item.itemType,
                priority: item.priority,
                status: item.status,
                keyword: item.primaryKeyword,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );
}
