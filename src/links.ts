import { webUrl } from "./config.js";

export type DashboardSection =
  | "overview"
  | "seo"
  | "seo_competitors"
  | "seo_keywords"
  | "seo_clusters"
  | "seo_briefs"
  | "seo_results"
  | "posts"
  | "blogs"
  | "landing_pages"
  | "reddit"
  | "jobs"
  | "weekly_schedule"
  | "brandmind"
  | "storylines"
  | "knowledge"
  | "trends"
  | "competitors";

const SECTION_PATHS: Record<DashboardSection, string> = {
  overview: "",
  seo: "/seo",
  seo_competitors: "/seo?tab=competitors",
  seo_keywords: "/seo?tab=keywords",
  seo_clusters: "/seo?tab=clusters",
  seo_briefs: "/seo?tab=briefs",
  seo_results: "/seo?tab=results",
  posts: "/posts",
  blogs: "/blogs",
  landing_pages: "/landing-pages",
  reddit: "/reddit",
  jobs: "/jobs",
  weekly_schedule: "/weekly-schedule",
  brandmind: "/brandmind",
  storylines: "/storylines",
  knowledge: "/knowledge",
  trends: "/trends",
  competitors: "/competitors",
};

export function brandDashboardUrl(brandId: string, section: DashboardSection = "overview"): string {
  const path = SECTION_PATHS[section];
  return `${webUrl}/dashboard/brands/${brandId}${path}`;
}

export function generateSessionUrl(brandId: string, sessionId: string): string {
  return `${webUrl}/dashboard/brands/${brandId}/generate/session/${sessionId}?total=1`;
}

export function visualEditorUrl(brandId: string, postId: string, platform: string): string {
  return `${webUrl}/dashboard/brands/${brandId}/visual-creator/${postId}/edit?platform=${encodeURIComponent(platform)}`;
}

export function postDetailUrl(brandId: string, postId: string): string {
  return `${webUrl}/dashboard/brands/${brandId}/posts/${postId}`;
}
