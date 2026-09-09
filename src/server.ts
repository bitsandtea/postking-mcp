/**
 * Centralized MCP server factory. Both transports (stdio, streamable HTTP)
 * share this wiring so tools stay in lockstep.
 *
 * When called with a `token` (HTTP transport), the server keeps that token in
 * a closure-scoped slot so concurrent sessions don't clobber each other via
 * `process.env`. The stdio path passes no token and falls back to env/disk.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { setSessionToken } from "./config.js";
import { log, redactForLog } from "./log.js";
import { annotationsFor } from "./toolAnnotations.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerBrandTools } from "./tools/brand.js";
import { registerPostTools } from "./tools/posts.js";
import { registerRepurposeTools } from "./tools/repurpose.js";
import { registerTextTools } from "./tools/text.js";
import { registerVoiceTools } from "./tools/voice.js";
import { registerEditorTools } from "./tools/editor.js";
import { registerSocialTools } from "./tools/social.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerUserTools } from "./tools/user.js";
import { registerBlogTools } from "./tools/blog.js";
import { registerSeoTools } from "./tools/seo/index.js";
import { registerKeyTools } from "./tools/keys.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerWeeklyScheduleTools } from "./tools/weekly-schedule.js";
import { registerVisualTools } from "./tools/visuals.js";
import { registerVisualsPostTools } from "./tools/visuals-post.js";
import { registerImageSuggestionTools } from "./tools/image-suggestions.js";
import { registerPerplexitySearchTools } from "./tools/perplexity-search.js";
import { registerLpTools } from "./tools/lp.js";
import { registerBlockTools } from "./tools/blocks.js";
import { registerLinkTools } from "./tools/links.js";
import { registerRedditTools } from "./tools/reddit.js";
import { registerStorylineTools } from "./tools/storylines.js";
import { registerCompetitorTools } from "./tools/competitors.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerBrandTruthTools } from "./tools/brand-truth.js";
import { registerAudienceTools } from "./tools/audience.js";
import { registerTrendsTools } from "./tools/trends.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerSearchPerformanceTools } from "./tools/search-performance.js";
import { registerBrandToolsTools } from "./tools/brand-tools.js";
import { registerPrompts } from "./prompts.js";

// Both `src/server.ts` (via tsx) and the compiled `dist/server.js` sit one
// directory below the repo root, so this resolves to package.json in either case.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

export function createServer(token?: string): McpServer {
  const server = new McpServer(
    {
      name: "postking",
      version: pkg.version,
    },
    {
      instructions: `You're connected to PostKing — a hosted platform for social content, blogs, SEO/GEO, and landing pages. ~270 tools cover the full surface: posts, blogs, SEO, landing pages, visuals, Reddit, billing, search performance / AI visibility reporting, and more.

## Start every session here
1. Call \`list_brands\` to see which brands this account can access.
2. Call \`set_active_brand(brandId)\` before any brand-scoped tool call. On the hosted HTTP transport this persists for your logged-in account across reconnects and server restarts, so you usually only need to set it once. On stdio, or the very first time, it isn't set yet.
3. If a tool returns "no brand selected" or similar, call \`set_active_brand\` and retry — don't treat it as a hard failure.

## Authentication — read this before touching auth tools
Call \`health\` any time — it needs no valid token and reports local auth state (\`transport\`, \`loggedIn\`, \`tokenSource\`, and a \`nextStep\` telling you exactly what to do).
This server supports two transports with different auth models, and \`login_start\`/\`login_complete\`/\`whoami\`/\`logout\` are registered on both — but they behave differently:
- **stdio** (local, spawned by your MCP client): these tools run a real device-authorization flow. If a tool reports "not logged in," call \`login_start\` — it returns a short link and code; show both to the user, have them approve in their browser, then call \`login_complete\` to finish. \`logout\` clears the local credential file.
- **HTTP (remote, OAuth)**: auth is handled entirely by your MCP client's own OAuth flow (dynamic client registration + PKCE) before any tool call happens, so there's no in-session login step. On this transport \`login_start\`/\`login_complete\`/\`logout\` just explain the OAuth model and how to reconnect/re-authorize instead of running a device flow — call \`whoami\` or \`health\` to check the current session. Don't try to "fix" a stdio connection by switching it to HTTP/OAuth or vice versa; treat the transport your client is configured with as fixed for the session.

## Async operations: always poll, never assume
Most generation/heavy actions (\`generate_post\`, \`seo_generate_clusters\`, \`seo_write_article\`, \`reddit_generate_pool\`, vibe edits, etc.) return an operation that's still running. Two patterns exist:
- Tools like \`generate_post\` poll internally and block until done — wait for \`operationStatus: COMPLETED\` in the response before reading \`content\`/\`variations\`. Treat "RUNNING" for more than ~60s as a transient hiccup, not failure — retry the read, don't resubmit (resubmitting wastes credits and creates duplicates).
- Tools that return an \`operationId\` (most SEO/cluster/brief/article/Reddit-pool steps) need an explicit follow-up: poll \`get_job(operationId)\` (or pass \`wait: true\` where supported) until \`state\` is \`completed\` or \`failed\`. Before generating something that might already exist (e.g. a Reddit pool), check \`list_operations(kind=..., state='completed')\` first — regenerating wastes credits.

## Credits
Generation costs credits. Call \`get_credits\` before a \`generate_post\`/\`generate_blog_post\`/similar call if you're not sure there's balance — a failed generation due to "insufficient credits" still costs you a wasted round trip. Top up with \`billing_topup\`.

## Common pitfalls worth knowing up front
- **Status filters are exact strings.** When listing drafts, filter on \`status='draft'\`, not \`'created'\` — the API rejects unrecognized status values.
- **\`create_post\` requires \`scheduledAt\`** (ISO 8601). Omitting it returns a generic "invalid option" error that doesn't say which field is missing.
- **Visuals are never auto-attached.** \`generate_post_visual_options\`/\`search_stock_images\` only return candidates — you must call \`pick_post_visual\` explicitly to attach one.
- **Custom themes are free-text, not IDs.** Pass a descriptive string to \`theme\`, or register one first with the template/theme creation tool if you want it reusable.
- **API keys are scoped.** Content-generation calls need a \`write\`-scoped key. "Invalid or revoked API key" usually means the active key's scope is wrong or it was rotated — create a fresh one rather than debugging the old one.
- **A bare "No approval received" (or similar) error is your MCP client's own approval prompt going unanswered** — not a PostKing error, not a permissions/scope problem, and not brand-specific. It can happen on any tool, including read-only ones. Approve the prompt in your client (choosing "always allow" for this connector stops the repeats) and retry the identical call — re-running with different arguments or calling \`set_active_brand\`/re-authenticating will not help.

## Where to go deeper
This server also exposes guided prompts for common end-to-end flows — \`getting_started\`, and others covering SEO/GEO (seed keywords → clusters → briefs → articles), content weeks, Reddit distribution, and landing pages. Prefer invoking those for a first-time walkthrough of a flow rather than guessing the tool order from names alone.`,
    }
  );

  // Per-session token store — resolved by `config.getToken()`.
  setSessionToken(server, token ?? null);

  // Recognized ToolAnnotations keys — used to tell an annotations object
  // apart from a Zod raw shape (both are plain objects at this layer).
  const ANNOTATION_KEYS = new Set(["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);

  // A Zod schema value carries `_def` and a `.parse` method; a real
  // annotations value (string/boolean) never does. Any object whose keys
  // aren't all recognized annotation keys — or whose values look like Zod
  // schemas — is a raw params shape, not annotations.
  function looksLikeAnnotations(candidate: unknown): candidate is ToolAnnotations {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length === 0) return false; // an empty object is a valid empty raw shape; never real annotations here
    return entries.every(([key, value]) => {
      if (!ANNOTATION_KEYS.has(key)) return false;
      if (value && typeof value === "object" && ("_def" in value || typeof (value as { parse?: unknown }).parse === "function")) {
        return false;
      }
      return true;
    });
  }

  // Wrap server.tool to (1) splice in centrally-derived MCP tool annotations
  // — merging with any annotations a call site already passes, call-site
  // keys winning — and (2) emit structured [tool] logs on every invocation.
  // Handles every arity `McpServer#tool` supports: (name, cb),
  // (name, description, cb), (name, schemaOrAnnotations, cb),
  // (name, description, schema, cb), (name, schema, annotations, cb), and
  // (name, description, schema, annotations, cb).
  const originalTool = server.tool.bind(server);
  (server as any).tool = (...toolArgs: any[]) => {
    const name: string = toolArgs[0];
    const handlerIndex = toolArgs.length - 1;
    const originalHandler = toolArgs[handlerIndex];

    let description: string | undefined;
    let schema: unknown;
    let callSiteAnnotations: Partial<ToolAnnotations> | undefined;
    for (const arg of toolArgs.slice(1, handlerIndex)) {
      if (typeof arg === "string") {
        description = arg;
      } else if (looksLikeAnnotations(arg)) {
        callSiteAnnotations = arg;
      } else if (arg && typeof arg === "object") {
        schema = arg;
      }
    }

    const mergedAnnotations: ToolAnnotations = { ...annotationsFor(name), ...(callSiteAnnotations ?? {}) };

    const newArgs: unknown[] = [name];
    if (description !== undefined) newArgs.push(description);
    if (schema !== undefined) newArgs.push(schema);
    newArgs.push(mergedAnnotations);

    if (typeof originalHandler === "function") {
      newArgs.push(async (...handlerArgs: any[]) => {
        const args = handlerArgs[0];
        log("tool", "→ " + name, redactForLog(args));
        const start = Date.now();
        try {
          const result = await originalHandler(...handlerArgs);
          const ms = Date.now() - start;
          log("tool", "← " + name + " (" + ms + "ms)");
          return result;
        } catch (err) {
          const ms = Date.now() - start;
          log("tool", "✗ " + name + " (" + ms + "ms)", { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      });
    } else {
      newArgs.push(originalHandler);
    }

    return (originalTool as any)(...newArgs);
  };

  // login_start / login_complete / logout / whoami are registered on both
  // transports. On stdio they run the real device-code flow; on HTTP (where
  // OAuth bearer auth already gated the session before it existed, §5.2) they
  // explain that model and how to reconnect instead of erroring cryptically.
  registerAuthTools(server);
  registerBrandTools(server);
  registerPostTools(server);
  registerRepurposeTools(server);
  registerTextTools(server);
  registerVoiceTools(server);
  registerEditorTools(server);
  registerSocialTools(server);
  registerDomainTools(server);
  registerUserTools(server);
  registerBlogTools(server);
  registerSeoTools(server);
  registerKeyTools(server);
  registerJobTools(server);
  registerWeeklyScheduleTools(server);
  registerVisualTools(server);
  registerVisualsPostTools(server);
  registerImageSuggestionTools(server);
  registerPerplexitySearchTools(server);
  registerLpTools(server);
  registerBlockTools(server);
  registerLinkTools(server);
  registerRedditTools(server);
  registerStorylineTools(server);
  registerCompetitorTools(server);
  registerKnowledgeTools(server);
  registerBrandTruthTools(server);
  registerAudienceTools(server);
  registerTrendsTools(server);
  registerBillingTools(server);
  registerSearchPerformanceTools(server);
  registerBrandToolsTools(server);
  registerPrompts(server);

  return server;
}
