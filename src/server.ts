/**
 * Centralized MCP server factory. Both transports (stdio, streamable HTTP)
 * share this wiring so tools stay in lockstep.
 *
 * When called with a `token` (HTTP transport), the server keeps that token in
 * a closure-scoped slot so concurrent sessions don't clobber each other via
 * `process.env`. The stdio path passes no token and falls back to env/disk.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setSessionToken } from "./config.js";
import { log } from "./log.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerBrandTools } from "./tools/brand.js";
import { registerPostTools } from "./tools/posts.js";
import { registerRepurposeTools } from "./tools/repurpose.js";
import { registerVoiceTools } from "./tools/voice.js";
import { registerEditorTools } from "./tools/editor.js";
import { registerSocialTools } from "./tools/social.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerUserTools } from "./tools/user.js";
import { registerBlogTools } from "./tools/blog.js";
import { registerSeoTools } from "./tools/seo.js";
import { registerKeyTools } from "./tools/keys.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerWeeklyScheduleTools } from "./tools/weekly-schedule.js";
import { registerVisualTools } from "./tools/visuals.js";
import { registerVisualsPostTools } from "./tools/visuals-post.js";
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

export function createServer(token?: string): McpServer {
  const server = new McpServer({
    name: "postking",
    version: "1.1.0",
  });

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
        log("tool", "→ " + name, args);
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

  // login_start / login_complete / logout are device-code tools for stdio/local
  // sessions only. The HTTP/remote transport requires OAuth bearer authentication
  // before a session is created (§5.2), so these tools are never reachable there.
  if (process.env.POSTKING_MCP_TRANSPORT !== "http") {
    registerAuthTools(server);
  }
  registerBrandTools(server);
  registerPostTools(server);
  registerRepurposeTools(server);
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
