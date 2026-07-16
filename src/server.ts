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
import { setSessionToken } from "./config.js";
import { log, redactForLog } from "./log.js";
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
import { registerLinkTools } from "./tools/links.js";
import { registerRedditTools } from "./tools/reddit.js";
import { registerStorylineTools } from "./tools/storylines.js";
import { registerCompetitorTools } from "./tools/competitors.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerBrandTruthTools } from "./tools/brand-truth.js";
import { registerAudienceTools } from "./tools/audience.js";
import { registerTrendsTools } from "./tools/trends.js";
import { registerBillingTools } from "./tools/billing.js";
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
      instructions: `You're connected to PostKing — a hosted platform for social content, blogs, SEO/GEO, and landing pages. ~140 tools cover the full surface: posts, blogs, SEO, landing pages, visuals, Reddit, billing, and more.

## Start every session here
1. Call \`list_brands\` to see which brands this account can access.
2. Call \`set_active_brand(brandId)\` before any brand-scoped tool call. Brand selection is per-session — it does NOT persist across reconnects, so re-apply it at the start of every new session.
3. If a tool returns "no brand selected" or similar, you skipped step 2 — call \`set_active_brand\` and retry, don't treat it as a hard failure.

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

## Where to go deeper
This server also exposes guided prompts for common end-to-end flows — \`getting_started\`, and others covering SEO/GEO (seed keywords → clusters → briefs → articles), content weeks, Reddit distribution, and landing pages. Prefer invoking those for a first-time walkthrough of a flow rather than guessing the tool order from names alone.`,
    }
  );

  // Per-session token store — resolved by `config.getToken()`.
  setSessionToken(server, token ?? null);

  // Wrap server.tool to emit structured [tool] logs on every invocation.
  const originalTool = server.tool.bind(server);
  (server as any).tool = (...toolArgs: any[]) => {
    const name: string = toolArgs[0];
    const lastArg = toolArgs[toolArgs.length - 1];
    if (typeof lastArg === "function") {
      const originalHandler = lastArg;
      toolArgs[toolArgs.length - 1] = async (...handlerArgs: any[]) => {
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
      };
    }
    return (originalTool as any)(...toolArgs);
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
  registerLinkTools(server);
  registerRedditTools(server);
  registerStorylineTools(server);
  registerCompetitorTools(server);
  registerKnowledgeTools(server);
  registerBrandTruthTools(server);
  registerAudienceTools(server);
  registerTrendsTools(server);
  registerBillingTools(server);
  registerPrompts(server);

  return server;
}
