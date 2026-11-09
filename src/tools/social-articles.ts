import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";
import { detailParam, projectList, type Projector } from "../detail.js";
import { languageParam } from "../languages.js";

const brandOpt = z.string().optional().describe("Brand ID (defaults to active brand)");

const platformEnum = z.enum(["linkedin", "x"]);
const statusEnum = z.enum(["generating", "draft", "ready", "published", "failed"]);

const imageRefShape = {
  assetId: z.string().min(1).nullable().optional().describe("Id of an image asset in this brand's library (list_assets); the URL is resolved server-side. Null/omitted keeps the existing slot (only alt/caption change), so empty slots stay empty."),
  alt: z.string().optional(),
  caption: z.string().optional(),
  prompt: z.string().optional().describe("Generation prompt stored for this slot (blank = keep the stored one)."),
};

type Img = { marker?: number; url?: string | null; alt?: string; caption?: string; prompt?: string | null } | null | undefined;

/** Converts the article's constrained HTML (h2,h3,p,strong,em,ul,ol,li,blockquote,a,br + image placeholders) to markdown. */
export function bodyHtmlToMarkdown(html: string): string {
  let out = html ?? "";
  out = out.replace(/<p[^>]*data-image-marker="(\d+)"[^>]*>\s*<\/p>/gi, (_m, n) => `\n\n[Image ${n}]\n\n`);
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n\n## ${t}\n\n`);
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n\n### ${t}\n\n`);
  out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) =>
    "\n\n" + String(t).replace(/<\/?p[^>]*>/gi, "").trim().split("\n").map((l: string) => `> ${l}`).join("\n") + "\n\n"
  );
  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    let i = 0;
    return "\n\n" + String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_x, t) => `${++i}. ${String(t).trim()}\n`) + "\n";
  });
  out = out.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) =>
    "\n\n" + String(inner).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_x, t) => `- ${String(t).trim()}\n`) + "\n"
  );
  out = out.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `[${t}](${href})`);
  out = out.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  out = out.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/p>/gi, "\n\n").replace(/<p[^>]*>/gi, "");
  out = out.replace(/<[^>]+>/g, "");
  out = out.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Compact image-slot view of an article (one marker, or all slots when omitted). */
function imageSummary(article: unknown, marker?: number) {
  const a = asRecord(article);
  const cover = (a.coverImage ?? null) as Img;
  const inline = (Array.isArray(a.inlineImages) ? a.inlineImages : []) as NonNullable<Img>[];
  const slots = [cover ? { ...cover, marker: 0 } : null, ...inline].filter((i): i is NonNullable<Img> => !!i);
  const picked = marker === undefined ? slots : slots.filter((i) => i.marker === marker);
  return { articleId: a.id ?? null, images: picked.map((i) => ({ marker: i.marker, url: i.url ?? null, alt: i.alt, prompt: i.prompt ?? null })) };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** An image slot in the kit: filled slots carry the url; empty ones say so and keep their prompt. */
function slotKit(i: NonNullable<Img>) {
  return i.url
    ? { marker: i.marker, url: i.url, alt: i.alt, caption: i.caption }
    : { marker: i.marker, url: null, status: "no image yet", prompt: i.prompt ?? null, alt: i.alt, caption: i.caption };
}

/** Builds the copy-and-paste kit returned by get_social_article. */
export function buildPasteKit(article: Record<string, unknown>) {
  const bodyHtml = typeof article.bodyHtml === "string" ? article.bodyHtml : "";
  const cover = (article.coverImage ?? null) as Img;
  const inline = (Array.isArray(article.inlineImages) ? article.inlineImages : []) as NonNullable<Img>[];
  const platform = article.platform === "x" ? "x" : "linkedin";
  return {
    title: article.title ?? null,
    subtitle: article.subtitle ?? null,
    bodyHtml,
    bodyMarkdown: bodyHtmlToMarkdown(bodyHtml),
    coverImage: cover ? slotKit(cover) : null,
    inlineImages: inline.map((i) => slotKit(i)),
    imagesMissing: [cover, ...inline].filter((i): i is NonNullable<Img> => !!i && !i.url).map((i) => i.marker ?? 0),
    teaserPost: article.teaserPost ?? null,
    editorUrl: platform === "x" ? "https://x.com/compose/articles" : "https://www.linkedin.com/article/new/",
    steps: [
      `Open the ${platform === "x" ? "X Articles" : "LinkedIn article"} editor.`,
      "Paste the title, subtitle and body (bodyMarkdown has [Image N] markers where images go).",
      "Upload the cover image, then upload each inline image at its [Image N] marker (download from the URLs). Slots with \"no image yet\" need generate_social_article_image(s) first, or skip them.",
      "Publish, then share the teaserPost. On X the teaserPost is the caption for the article (max 256 characters).",
      "Call update_social_article with publishedUrl set to the live URL.",
    ],
  };
}

const listProj: Projector<Record<string, unknown>> = {
  short: (a) => ({ id: a.id, platform: a.platform, title: a.title, status: a.status }),
  medium: (a) => ({
    id: a.id,
    platform: a.platform,
    title: a.title,
    status: a.status,
    wordCount: a.wordCount,
    targetKeyword: a.targetKeyword ?? null,
    publishedUrl: a.publishedUrl ?? null,
    createdAt: a.createdAt,
  }),
};

export function registerSocialArticleTools(server: McpServer) {
  // ── Generate (async) ──────────────────────────────────────────────────────
  server.tool(
    "generate_social_article",
    [
      "Generate a long-form LinkedIn (Pulse) or X article, written fresh in that platform's style. TEXT ONLY: the article comes with empty image slots (a cover plus 2-5 inline), each carrying a prompt.",
      "LinkedIn: 1,200-2,500 words, first-person expert voice, keyword-front-loaded title (it becomes the Pulse URL slug). Pulse articles are indexed by Google and cited by AI answer engines, so this is an SEO/GEO play. X: 800-2,000 words, punchy short paragraphs, hook title, reach-oriented (not reliably indexed).",
      "Source: pass `topic`, or `seoBriefId` (its keyword and outline guide the piece), or `sourceBlogArticleId`. A blog article is RESEARCH INPUT ONLY (facts, citations) — the article is written fresh with a different angle and structure, never a rewrite of the blog. Never paste a blog verbatim into LinkedIn: it can outrank the brand's own blog.",
      "There is NO publishing API. The result is a paste kit: get_social_article returns title, subtitle, body (HTML and markdown with [Image N] markers), cover and inline image URLs, and a teaser post. The user pastes it into the LinkedIn/X editor themselves, then you call update_social_article with `publishedUrl`.",
      "Credit cost: 25 credits, text only. Images are separate: after reviewing the text, offer the user image generation (generate_social_article_image per slot, or generate_social_article_images for all empty slots, 30 credits each), or picking existing brand assets via update_social_article (coverImage / inlineImages, free). Ask before spending credits on images.",
      "Async — returns { articleId, operationId }. Poll get_job(operationId, wait: true) until state is 'completed', then call get_social_article.",
    ].join(" "),
    {
      platform: platformEnum.describe('"linkedin" (Pulse article, SEO-oriented) or "x" (X Article, reach-oriented).'),
      topic: z.string().min(1).optional().describe("What the article is about. Required unless sourceBlogArticleId or seoBriefId is given."),
      sourceBlogArticleId: z.string().optional().describe("Existing blog article id (list_blogs). Used as RESEARCH INPUT ONLY (facts, citations): the article is written fresh in the platform's style, never rewritten from the blog text."),
      seoBriefId: z.string().optional().describe("SEO brief id (seo_list_briefs): its keyword and outline guide the article."),
      targetKeyword: z.string().optional().describe("LinkedIn only: keyword front-loaded in the title (it becomes the Pulse URL slug)."),
      voiceProfileId: z.string().optional().describe("Voice profile id (list_voices) to apply to the draft."),
      imageCount: z.number().int().min(2).max(5).optional().describe("Inline image slots, 2 to 5 (default 3), plus a cover slot. Slots start empty; images bill separately (30 credits each) when generated."),
      language: languageParam("Applies to this article only."),
      brandId: brandOpt,
    },
    async ({ brandId, ...body }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/social-articles`, body);
      const article = data?.article ?? null;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            articleId: article?.id ?? null,
            operationId: data?.operationId ?? article?.operationId ?? null,
            status: article?.status ?? "generating",
            note: "Generation is async. Poll get_job(operationId, wait: true) until state is 'completed' (or 'failed'), then call get_social_article to read the paste kit. Do not resubmit while it is running.",
          }, null, 2),
        }],
      };
    }
  );

  // ── Generate one image slot ───────────────────────────────────────────────
  server.tool(
    "generate_social_article_image",
    [
      "Generate (or regenerate) ONE image of a LinkedIn/X article: marker 0 is the cover, 1..N are the inline images at the [Image N] placeholders. 30 credits per call.",
      "Optional `prompt` gives creative direction; omit it to use the slot's stored prompt. Synchronous. Returns the updated image slot; call get_social_article for the full kit.",
    ].join(" "),
    {
      articleId: z.string().describe("Social article ID"),
      marker: z.number().int().min(0).describe("0 = cover, 1..N = inline image marker"),
      prompt: z.string().optional().describe("Optional creative direction for the new image."),
      brandId: brandOpt,
    },
    async ({ articleId, marker, prompt, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/social-articles/${articleId}/images/${marker}/regenerate`, { prompt });
      return { content: [{ type: "text" as const, text: JSON.stringify(imageSummary(data?.article, marker), null, 2) }] };
    }
  );

  // ── Generate all empty image slots ────────────────────────────────────────
  server.tool(
    "generate_social_article_images",
    [
      "Generate every EMPTY image slot of a LinkedIn/X article (cover + inline) in one call, 30 credits per image. Confirm the cost with the user first (count the slots with url null in get_social_article).",
      "Slots that already have an image are left alone. Returns the resulting slots.",
    ].join(" "),
    {
      articleId: z.string().describe("Social article ID"),
      brandId: brandOpt,
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.post<any>(`/api/agent/v1/brands/${id}/social-articles/${articleId}/images/generate-all`, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(imageSummary(data?.article), null, 2) }] };
    }
  );

  // ── Get (with paste kit) ──────────────────────────────────────────────────
  server.tool(
    "get_social_article",
    [
      "Get one LinkedIn/X article by id, plus a paste kit: title, subtitle, bodyHtml, bodyMarkdown (with [Image N] markers), cover and inline image URLs (+ alt/caption), teaser post, and the editor URL.",
      "There is no publishing API — present the kit to the user to paste into the LinkedIn/X editor, then call update_social_article with `publishedUrl` once it is live.",
      "If status is 'generating', poll get_job with the article's operationId; 'failed' carries an `error`.",
    ].join(" "),
    {
      articleId: z.string().describe("Social article ID"),
      brandId: brandOpt,
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/social-articles/${articleId}`);
      const article = asRecord(data?.article ?? data);
      const ready = article.status !== "generating" && article.status !== "failed";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            article,
            pasteKit: ready ? buildPasteKit(article) : null,
            note: article.status === "generating"
              ? "Still generating. Poll get_job(operationId, wait: true), then call this again."
              : article.status === "failed"
                ? `Generation failed: ${String(article.error ?? "unknown error")}. Generate again.`
                : "Have the user paste this into the editor, then call update_social_article with publishedUrl.",
          }, null, 2),
        }],
      };
    }
  );

  // ── List ──────────────────────────────────────────────────────────────────
  server.tool(
    "list_social_articles",
    [
      "List the brand's LinkedIn/X long-form articles, optionally filtered by platform and status.",
      "short {id,platform,title,status}; medium adds wordCount, targetKeyword, publishedUrl, createdAt; full = raw (includes bodies). Use get_social_article for the paste kit.",
    ].join(" "),
    {
      platform: platformEnum.optional().describe("Filter by platform."),
      status: statusEnum.optional().describe("Filter by status."),
      detail: detailParam("short"),
      brandId: brandOpt,
    },
    async ({ platform, status, detail, brandId }) => {
      const id = requireBrandId(brandId);
      const qs = new URLSearchParams();
      if (platform) qs.set("platform", platform);
      if (status) qs.set("status", status);
      const q = qs.toString();
      const data = await api.get<any>(`/api/agent/v1/brands/${id}/social-articles${q ? `?${q}` : ""}`);
      const rows = (Array.isArray(data?.articles) ? data.articles : []) as Record<string, unknown>[];
      return { content: [{ type: "text" as const, text: JSON.stringify({ articles: projectList(detail, rows, listProj), count: rows.length }) }] };
    }
  );

  // ── Update ────────────────────────────────────────────────────────────────
  server.tool(
    "update_social_article",
    [
      "Edit a LinkedIn/X article, or record that it was published.",
      "After the user pastes the article into LinkedIn/X, call this with `publishedUrl` — setting it marks the article published (feeds the AI-visibility probe and the teaser post).",
      "bodyHtml allows only h2, h3, p, strong, em, ul, ol, li, blockquote, a, br; keep image placeholders as <p data-image-marker=\"N\"></p>. coverImage swaps the cover for a brand asset (null clears it); inlineImages replaces the full inline list and every marker must exist as a placeholder in bodyHtml.",
      "Editing is free. Empty image slots can be filled with a brand asset here, or generated with generate_social_article_image(s).",
    ].join(" "),
    {
      articleId: z.string().describe("Social article ID"),
      title: z.string().min(1).optional(),
      subtitle: z.string().nullable().optional(),
      bodyHtml: z.string().optional().describe('Allowed tags only: h2, h3, p, strong, em, ul, ol, li, blockquote, a, br. Keep image placeholders as <p data-image-marker="N"></p>. Anything else is stripped.'),
      teaserPost: z.string().nullable().optional().describe("Companion post to share the article. On X articles this is the caption posted with the article (max 256 characters, plain text)."),
      targetKeyword: z.string().nullable().optional(),
      publishedUrl: z.string().url().nullable().optional().describe("Live URL after pasting the article into LinkedIn / X. Setting it marks the article published."),
      status: z.enum(["draft", "ready", "published"]).optional(),
      coverImage: z.object(imageRefShape).nullable().optional().describe("Swap the cover for a brand asset; null clears it. Empty slots are kept as-is."),
      inlineImages: z
        .array(z.object({ marker: z.number().int().min(1), ...imageRefShape }))
        .optional()
        .describe('Replaces the full inline image list. Every marker must exist as <p data-image-marker="N"></p> in bodyHtml.'),
      brandId: brandOpt,
    },
    async ({ articleId, brandId, ...patch }) => {
      const id = requireBrandId(brandId);
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/social-articles/${articleId}`, patch);
      const article = asRecord(data?.article ?? data);
      return { content: [{ type: "text" as const, text: JSON.stringify({ article: { id: article.id, platform: article.platform, title: article.title, status: article.status, publishedUrl: article.publishedUrl ?? null, wordCount: article.wordCount }, updated: true }, null, 2) }] };
    }
  );
}
