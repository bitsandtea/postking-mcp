/**
 * Single source of truth for async-operation duration ETAs.
 *
 * Keys are the REAL `OperationKind` enum values emitted by the PostKing API
 * (see `enum OperationKind` in the main app's prisma/schema.prisma) — they match
 * the `kind` field that `get_job` returns. Values are approximate human ranges.
 *
 * Kinds not present here have no known ETA — `etaFor` returns null and callers
 * should show nothing.
 */
const ETA_BY_KIND: Record<string, string> = {
  // Reddit
  brand_reddit_pool_generate: "~1–3 min",
  // SEO keyword expansion (the agent's "generate keywords" wraps keyword-pull)
  seo_keyword_pull: "~1–3 min",
  seo_keyword_score: "~1–2 min",
  brand_keywords_generate: "~1–3 min",
  // SEO clustering
  seo_cluster_generate: "~1–2 min",
  // SEO briefs (fired per approved cluster)
  seo_brief_generate: "~2–5 min per cluster",
  // SEO article / comparison generation
  seo_article_generate: "~3–8 min per article",
  seo_comparison_generate: "~3–8 min per page",
  // SEO roadmap
  brand_roadmap_generate: "~1–2 min",
  // Landing pages / side pages
  landing_page_generate: "~2–5 min",
  landing_page_side_pages_generate: "~2–5 min",
  // Other obviously long-running brand content jobs
  brand_generate_blog: "~3–8 min",
  brand_generate_batch: "~2–5 min",
  brand_smart_week: "~2–5 min",
  competitor_batch_analyze: "~2–5 min",
  competitor_refresh_all: "~2–5 min",
  competitor_overview: "~2–5 min",
  // Storylines
  storyline_generate_brief: "~1–3 min",
  storyline_generate_strategy: "~2–5 min",
  storyline_regenerate_line_item: "~1–3 min",
  storyline_execute: "~3–8 min",
  // Knowledge base
  brand_knowledge_create: "~15–30 s",
  brand_knowledge_update: "~15–30 s",
  // Audience / ICP
  brand_audience_review_edit: "~30–90 s",
};

/** Human ETA string for an operation kind, or null when unknown. */
export function etaFor(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return ETA_BY_KIND[kind] ?? null;
}
