import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { api } from "../client.js";
import { requireBrandId } from "../state.js";

/**
 * Per-CTA tools for a blog article's `ctas[]` list (feature 106 Workstream C
 * — see PostKing's types/blog-ctas.ts, the pinned cross-repo data contract).
 *
 * `update_blog_article`'s `cta`/`sidePageInfo` params (src/tools/blog.ts)
 * only ever touch the end-anchored CTA (or the last one) — an article can
 * carry several CTAs (one per `after_h2` section plus an optional `end`
 * CTA), and these tools are how an agent addresses ANY of them individually
 * by id, without clobbering the others. Every write here reads the current
 * article, edits/adds/removes exactly one entry in its `ctas[]`, and PATCHes
 * back the FULL array (`ctas` is a full-replace field server-side — see
 * BlogPatchBody in lib/agent/schemas/blogs.ts).
 */

const brandOpt = z.string().optional().describe("Brand ID (uses active brand if omitted)");

const CTA_STYLES = ["strong", "light"] as const;

/** Mirrors BlogCtaAnchorShape in PostKing's lib/agent/schemas/blogs.ts exactly. */
const ctaAnchorShape = z.union([
  z.object({ type: z.literal("end") }).strict(),
  z.object({ type: z.literal("after_h2"), index: z.number().int().min(0) }).strict(),
]);
type CtaAnchor = { type: "end" } | { type: "after_h2"; index: number };

/**
 * Full CTA entry shape, for `blog_cta_add`'s server-facing body and for
 * `update_blog_article`'s `ctas` full-replace passthrough (src/tools/blog.ts).
 * Mirrors BlogCtaEntryShape (lib/agent/schemas/blogs.ts) / BlogCtaEntry
 * (types/blog-ctas.ts) — do not drift.
 */
export const blogCtaEntryShape = z
  .object({
    id: z.string().min(1).describe("Client-generatable, cuid-ish. Stable identity across edits/reorders — reuse the existing id when editing, invent a new one only for a brand-new CTA."),
    anchor: ctaAnchorShape,
    sidePageId: z.string().optional().describe("Existing side page id this CTA links to (from list_side_pages), when the target is a PostKing side page."),
    slug: z.string().optional(),
    ctaHref: z.string().describe("CTA link target URL."),
    header: z.string().describe("CTA block headline."),
    ctaText: z.string().describe("CTA block body copy."),
    ctaButtonText: z.string().describe("CTA button text."),
    ctaSource: z.enum(["generated", "side-page-match", "agent-edit", "user-edit", "pool"]),
    destinationId: z.string().optional().describe("Set when this CTA was drawn from the publication's manual CTA destination pool (Blog.ctaDestinations) — the CtaDestination.id it came from. Preserve it when patching a pool CTA you didn't retarget."),
    style: z.enum(CTA_STYLES).optional().describe("Visual treatment. Absent defaults to \"strong\"."),
  })
  .strict();

async function fetchArticle(id: string, articleId: string): Promise<Record<string, unknown>> {
  const data = await api.get<Record<string, unknown>>(`/api/agent/v1/brands/${id}/blogs/${articleId}`);
  return ((data as any)?.blog ?? (data as any)?.article ?? data) as Record<string, unknown>;
}

function getCtas(a: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray((a as any)?.ctas) ? ((a as any).ctas as Record<string, unknown>[]) : [];
}

/** Per-CTA read-back projection — the raw `anchor` is included (unlike
 * blog.ts's projectCtas, which only surfaces it inside the full article
 * echo) so a caller can target/avoid specific `after_h2` indices exactly. */
function projectCta(c: Record<string, unknown>) {
  return {
    id: c.id,
    anchor: c.anchor,
    url: c.ctaHref ?? null,
    label: c.ctaButtonText ?? null,
    headline: c.header ?? null,
    body: c.ctaText ?? null,
    style: (c.style as string | undefined) ?? "strong",
    source: c.ctaSource ?? null,
    sidePageId: c.sidePageId ?? null,
    slug: c.slug ?? null,
    destinationId: c.destinationId ?? null,
  };
}

/**
 * Rough count of `<h2>` tags in the article body — NOT the exact depth-
 * tracking top-level-only walk the server/renderer use
 * (src/services/seo/_lib/split-article-sections.ts) to resolve
 * `after_h2.index`. Good enough as a hint for how many section slots
 * probably exist; a heading nested inside a callout/table/Sources footer
 * would inflate this count without being a valid anchor target. Treat it as
 * informational, not authoritative — get_blog_article's content is the
 * source of truth.
 */
function approxSectionCount(postText: unknown): number | undefined {
  if (typeof postText !== "string") return undefined;
  const matches = postText.match(/<h2[\s>]/gi);
  return matches ? matches.length : 0;
}

function anchorOf(c: Record<string, unknown>): CtaAnchor | null {
  const a = c.anchor;
  if (!a || typeof a !== "object") return null;
  const obj = a as Record<string, unknown>;
  if (obj.type === "end") return { type: "end" };
  if (obj.type === "after_h2" && typeof obj.index === "number") return { type: "after_h2", index: obj.index };
  return null;
}

/** Mirrors validateBlogCtasAnchors (types/blog-ctas.ts) for a single
 * candidate anchor against the OTHER entries already on the article — lets
 * blog_cta_add/blog_cta_update fail fast with a clear message instead of
 * round-tripping to the server for a 400. */
function anchorConflict(others: Record<string, unknown>[], candidate: CtaAnchor): string | null {
  if (candidate.type === "end") {
    if (others.some((c) => anchorOf(c)?.type === "end")) {
      return "This article already has an end-anchored CTA. ctas[] may include at most one anchor with type \"end\" — pass a different anchor (e.g. { type: \"after_h2\", index: N }) or edit/delete the existing end CTA instead.";
    }
    return null;
  }
  const dupe = others.some((c) => {
    const a = anchorOf(c);
    return a?.type === "after_h2" && a.index === candidate.index;
  });
  if (dupe) {
    return `Another CTA is already anchored to after_h2 index ${candidate.index} — each section index may host at most one CTA. Call blog_cta_list to see what's taken and pick a different index.`;
  }
  return null;
}

function notFoundError(articleId: string, ctaId: string, ctas: Record<string, unknown>[]): Error {
  const ids = ctas.map((c) => c.id).filter(Boolean);
  return new Error(
    `CTA "${ctaId}" not found on article "${articleId}". Available CTA ids: ${ids.length ? ids.join(", ") : "(this article has no CTAs)"} — call blog_cta_list to confirm.`
  );
}

export function registerBlogCtaTools(server: McpServer) {
  // ── List CTAs ──────────────────────────────────────────────────────────────
  server.tool(
    "blog_cta_list",
    [
      "List every CTA on a blog article individually, each with its raw `anchor` object — the per-CTA counterpart to get_blog_article's ctas[] projection.",
      "Use this to find the exact ctaId to pass to blog_cta_update/blog_cta_delete, or to see which anchor slots (the single `end` slot, and which `after_h2` indices) are already taken before calling blog_cta_add.",
      "`sectionCount` is an approximate `<h2>` count in the article body — a hint, not authoritative; verify against get_blog_article's content for an article with unusual nesting.",
    ].join(" "),
    {
      articleId: z.string().describe("Blog article ID"),
      brandId: brandOpt,
    },
    async ({ articleId, brandId }) => {
      const id = requireBrandId(brandId);
      const a = await fetchArticle(id, articleId);
      const ctas = getCtas(a);
      const result = {
        articleId,
        ctas: ctas.map(projectCta),
        ctaCount: ctas.length,
        sectionCount: approxSectionCount((a as any).postText),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Update one CTA ─────────────────────────────────────────────────────────
  server.tool(
    "blog_cta_update",
    [
      "Edit ONE CTA on a blog article by its ctaId, leaving every other CTA on the article untouched — the per-CTA counterpart to update_blog_article's `cta` field, which only ever edits the end-anchored (or last) CTA.",
      "Pass only the fields you want to change; omitted fields keep their current value. Changing `anchor` is validated against the article's OTHER CTAs first (at most one `end` anchor, unique `after_h2` indices) and fails with a clear error before any write.",
      "Passing `url` or `sidePageId` clears this CTA's `destinationId` (it can no longer be attributed to the publication's manual CTA pool once retargeted).",
      "Returns the article's full resulting ctas[] so you can confirm the edit alongside every other CTA's state.",
    ].join(" "),
    {
      articleId: z.string().describe("Blog article ID"),
      ctaId: z.string().describe("CTA id to edit (from blog_cta_list or get_blog_article's ctas[])"),
      url: z.string().optional().describe("CTA link target URL."),
      label: z.string().optional().describe("CTA button text."),
      headline: z.string().optional().describe("CTA block headline."),
      body: z.string().optional().describe("CTA block body copy."),
      style: z.enum(CTA_STYLES).optional().describe("Visual treatment: \"strong\" (card) or \"light\" (compact, blends into the article flow)."),
      anchor: ctaAnchorShape.optional().describe("Move this CTA to a different anchor: { type: \"end\" } or { type: \"after_h2\", index: N } (0-based, over top-level <h2> headings). Rejected if it collides with another CTA already on this article."),
      sidePageId: z.string().optional().describe("Re-link this CTA to a different existing side page by id (from list_side_pages)."),
      slug: z.string().optional().describe("Side page slug to pair with sidePageId (cosmetic/back-compat mirror; ctaHref/url is the field that actually resolves the link)."),
      brandId: brandOpt,
    },
    async ({ articleId, ctaId, url, label, headline, body, style, anchor, sidePageId, slug, brandId }) => {
      if (
        url === undefined &&
        label === undefined &&
        headline === undefined &&
        body === undefined &&
        style === undefined &&
        anchor === undefined &&
        sidePageId === undefined &&
        slug === undefined
      ) {
        return {
          content: [{ type: "text" as const, text: "No fields to update. Pass at least one of: url, label, headline, body, style, anchor, sidePageId, slug." }],
        };
      }

      const id = requireBrandId(brandId);
      const a = await fetchArticle(id, articleId);
      const ctas = getCtas(a);
      const idx = ctas.findIndex((c) => c.id === ctaId);
      if (idx === -1) throw notFoundError(articleId, ctaId, ctas);

      if (anchor !== undefined) {
        const others = ctas.filter((_, i) => i !== idx);
        const conflict = anchorConflict(others, anchor as CtaAnchor);
        if (conflict) throw new Error(conflict);
      }

      const entry: Record<string, unknown> = { ...ctas[idx] };
      let contentChanged = false;
      if (url !== undefined) {
        entry.ctaHref = url;
        contentChanged = true;
      }
      if (label !== undefined) {
        entry.ctaButtonText = label;
        contentChanged = true;
      }
      if (headline !== undefined) {
        entry.header = headline;
        contentChanged = true;
      }
      if (body !== undefined) {
        entry.ctaText = body;
        contentChanged = true;
      }
      if (anchor !== undefined) {
        entry.anchor = anchor;
        contentChanged = true;
      }
      if (style !== undefined) entry.style = style;
      if (sidePageId !== undefined) entry.sidePageId = sidePageId;
      if (slug !== undefined) entry.slug = slug;
      if (url !== undefined || sidePageId !== undefined) delete entry.destinationId;
      if (contentChanged) entry.ctaSource = "agent-edit";

      const newCtas = [...ctas];
      newCtas[idx] = entry;

      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, { ctas: newCtas });
      const article = (data?.blog ?? data?.article ?? data) as Record<string, unknown>;
      const resultCtas = getCtas(article);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ articleId, ctas: resultCtas.map(projectCta), ctaCount: resultCtas.length }, null, 2),
          },
        ],
      };
    }
  );

  // ── Add a CTA ──────────────────────────────────────────────────────────────
  server.tool(
    "blog_cta_add",
    [
      "Append a NEW CTA to a blog article, leaving every existing CTA untouched.",
      "Anchor defaults to { type: \"end\" } (the article's end-of-content CTA) if omitted. The anchor is validated against the article's EXISTING CTAs before writing — at most one `end` anchor per article, and each `after_h2` index may host only one CTA — so a colliding anchor fails immediately with a clear error instead of a server 400.",
      "Returns the new CTA's id plus the article's full resulting ctas[].",
    ].join(" "),
    {
      articleId: z.string().describe("Blog article ID"),
      url: z.string().min(1).describe("CTA link target URL."),
      label: z.string().min(1).describe("CTA button text."),
      headline: z.string().min(1).describe("CTA block headline."),
      body: z.string().min(1).describe("CTA block body copy."),
      anchor: ctaAnchorShape.default({ type: "end" }).describe("Where this CTA renders: { type: \"end\" } (default) or { type: \"after_h2\", index: N } (0-based, over top-level <h2> headings)."),
      style: z.enum(CTA_STYLES).optional().describe("Visual treatment: \"strong\" (card, default) or \"light\" (compact, blends into the article flow)."),
      sidePageId: z.string().optional().describe("Existing side page id this CTA links to (from list_side_pages), when the target is a PostKing side page."),
      slug: z.string().optional().describe("Side page slug to pair with sidePageId (cosmetic/back-compat mirror; url is the field that actually resolves the link)."),
      brandId: brandOpt,
    },
    async ({ articleId, url, label, headline, body, anchor, style, sidePageId, slug, brandId }) => {
      const id = requireBrandId(brandId);
      const a = await fetchArticle(id, articleId);
      const ctas = getCtas(a);

      const conflict = anchorConflict(ctas, anchor as CtaAnchor);
      if (conflict) throw new Error(conflict);

      const newEntry: Record<string, unknown> = {
        id: `agent-${randomUUID()}`,
        anchor,
        ctaHref: url,
        header: headline,
        ctaText: body,
        ctaButtonText: label,
        ctaSource: "agent-edit",
        sidePageId,
        slug,
        style,
      };

      const newCtas = [...ctas, newEntry];
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, { ctas: newCtas });
      const article = (data?.blog ?? data?.article ?? data) as Record<string, unknown>;
      const resultCtas = getCtas(article);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { articleId, ctaId: newEntry.id, ctas: resultCtas.map(projectCta), ctaCount: resultCtas.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Delete one CTA ─────────────────────────────────────────────────────────
  server.tool(
    "blog_cta_delete",
    "Remove ONE CTA from a blog article by its ctaId, leaving every other CTA untouched. Removing the article's last remaining CTA sends an empty ctas[] (the server's documented way to clear all CTAs), not a legacy sidePageInfo write. Returns the article's full resulting ctas[].",
    {
      articleId: z.string().describe("Blog article ID"),
      ctaId: z.string().describe("CTA id to remove (from blog_cta_list or get_blog_article's ctas[])"),
      brandId: brandOpt,
    },
    async ({ articleId, ctaId, brandId }) => {
      const id = requireBrandId(brandId);
      const a = await fetchArticle(id, articleId);
      const ctas = getCtas(a);
      const idx = ctas.findIndex((c) => c.id === ctaId);
      if (idx === -1) throw notFoundError(articleId, ctaId, ctas);

      const remaining = ctas.filter((c) => c.id !== ctaId);
      const data = await api.patch<any>(`/api/agent/v1/brands/${id}/blogs/${articleId}`, { ctas: remaining });
      const article = (data?.blog ?? data?.article ?? data) as Record<string, unknown>;
      const resultCtas = getCtas(article);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { articleId, deletedCtaId: ctaId, ctas: resultCtas.map(projectCta), ctaCount: resultCtas.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
