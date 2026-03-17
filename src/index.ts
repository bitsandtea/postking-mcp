#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
import { registerPrompts } from "./prompts.js";

const server = new McpServer({
  name: "postking",
  version: "1.0.0",
});

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
registerPrompts(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers log to stderr so stdout stays clean for JSON-RPC
  process.stderr.write("PostKing MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
