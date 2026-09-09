/**
 * Central classifier that assigns MCP `ToolAnnotations` (title, readOnlyHint,
 * destructiveHint, idempotentHint, openWorldHint) to every tool by name.
 *
 * This exists so 270 `server.tool(...)` call sites don't each need to declare
 * annotations by hand — `src/server.ts`'s `server.tool` wrapper calls
 * `annotationsFor(name)` for every registration and splices the result in.
 * Without any annotations, MCP clients can't tell a read from a destructive
 * write, so every tool call gets gated behind the same approval prompt —
 * see the "No approval received" note in this server's `instructions`.
 *
 * Classification order: explicit per-name override table first, then
 * name-prefix/token rules, then a safe default (a plain write: not read-only,
 * not destructive, not idempotent).
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

type Hints = Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint">;

const READ_ONLY: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const DESTRUCTIVE: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
const WRITE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

// Exact-name overrides checked before any prefix/token rule. Only needed for
// names the general rules below can't reach (no read/list/get token, no
// delete/restore token, etc). Some entries here are also independently
// covered by the general rules — kept explicit anyway per spec, harmless.
const EXPLICIT_HINTS: Record<string, Hints> = {
  health: READ_ONLY,
  whoami: READ_ONLY,
  dashboard_link: READ_ONLY,
  trends_list: READ_ONLY,
  web_search: READ_ONLY,
  reddit_global_pool: READ_ONLY,
  seo_estimate_research_cost: READ_ONLY,
  storyline_estimate: READ_ONLY,
  competitor_comparison_sources: READ_ONLY,
  billing_wallet: READ_ONLY,
  billing_list_packs: READ_ONLY,
  billing_list_tiers: READ_ONLY,

  revoke_api_key: DESTRUCTIVE,
  disconnect_social_account: DESTRUCTIVE,
  remove_brand_language: DESTRUCTIVE,
  reddit_remove_from_pool: DESTRUCTIVE,
  cancel_post: DESTRUCTIVE,
  cancel_job: DESTRUCTIVE,
  clear_post_visual: DESTRUCTIVE,
  seo_bulk_delete_keywords: DESTRUCTIVE,
  logout: DESTRUCTIVE,
};

// Prefixes (name must START with these) that make a tool read-only.
const READ_ONLY_PREFIXES = ["list_", "get_", "view_", "search_", "check_", "preview_"];

// Underscore-delimited tokens that make a tool read-only wherever they occur
// (prefix, infix, or suffix) — e.g. `seo_get_brief`, `brand_truth_list`,
// `storyline_get_strategy`. `list_`/`get_` above are the prefix-only forms;
// these tokens generalize that to the infix/suffix cases the prefix rules miss.
const READ_ONLY_TOKENS = new Set(["get", "list"]);

// Underscore-delimited tokens that make a tool destructive wherever they
// occur — covers `delete_x`, `x_delete`, and `x_delete_y` alike.
const DESTRUCTIVE_TOKENS = new Set(["delete"]);

function tokens(name: string): string[] {
  return name.split("_");
}

function hasToken(name: string, token: string): boolean {
  return tokens(name).includes(token);
}

function classifyHints(name: string): Hints {
  const override = EXPLICIT_HINTS[name];
  if (override) return override;

  if (READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) return READ_ONLY;
  if (tokens(name).some((t) => READ_ONLY_TOKENS.has(t))) return READ_ONLY;
  if (name.endsWith("_status")) return READ_ONLY;

  if (tokens(name).some((t) => DESTRUCTIVE_TOKENS.has(t))) return DESTRUCTIVE;
  // Version-restore tools overwrite the current draft — treat like a
  // destructive write even though the name carries no "delete" token.
  if (name.startsWith("restore_") || name.endsWith("_restore")) return DESTRUCTIVE;

  return WRITE;
}

// Tools that reach outside PostKing itself (the open web, third-party APIs,
// social platforms, DNS). Exact names plus a couple of prefixes.
const OPEN_WORLD_EXACT = new Set([
  "web_search",
  "search_web_images",
  "search_stock_images",
  "verify_domain",
  "add_domain",
  "competitor_analyze",
  "competitor_refresh",
  "reddit_discover_subreddits",
  "import_asset_from_url",
  "import_blog_articles",
  "check_ai_content",
  "trends_list",
]);
const OPEN_WORLD_PREFIXES = ["publish_", "competitor_probe"];

function isOpenWorld(name: string): boolean {
  if (OPEN_WORLD_EXACT.has(name)) return true;
  return OPEN_WORLD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Small overrides for titles that read badly under the default
// snake_case -> "Sentence case" conversion. Kept intentionally tiny — the
// derived default (below) handles everything else.
const TITLE_OVERRIDES: Record<string, string> = {
  whoami: "Who am I",
  health: "Server health",
};

function toTitle(name: string): string {
  const override = TITLE_OVERRIDES[name];
  if (override) return override;

  let rest = name;
  let prefix = "";
  if (rest.startsWith("seo_")) {
    prefix = "SEO ";
    rest = rest.slice("seo_".length);
  }

  const words = rest.split("_").map((word) => (word === "lp" ? "landing page" : word));
  const text = words.join(" ");

  if (prefix) return prefix + text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pure function: derive full MCP tool annotations for a tool by its
 * registered name. No side effects — safe to unit test directly.
 */
export function annotationsFor(name: string): ToolAnnotations {
  const hints = classifyHints(name);
  return {
    title: toTitle(name),
    readOnlyHint: hints.readOnlyHint,
    destructiveHint: hints.destructiveHint,
    idempotentHint: hints.idempotentHint,
    openWorldHint: isOpenWorld(name),
  };
}
