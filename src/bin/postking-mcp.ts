#!/usr/bin/env node
/**
 * npm bin — stdio transport. Current behavior preserved for
 * `npx postking-mcp` users. Forces transport=stdio regardless of env.
 */
process.env.POSTKING_MCP_TRANSPORT = "stdio";
import("../index.js");
