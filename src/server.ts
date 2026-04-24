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
import { registerPrompts } from "./prompts.js";

export function createServer(token?: string): McpServer {
  const server = new McpServer({
    name: "postking",
    version: "1.1.0",
  });

  // Per-session token store — resolved by `config.getToken()`.
  setSessionToken(server, token ?? null);

  registerAuthTools(server);
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
  registerPrompts(server);

  return server;
}
