#!/usr/bin/env node
/**
 * Local HTTP-transport entrypoint. Useful for debugging and for hosted
 * deployment via the Dockerfile at the repo root.
 */
process.env.POSTKING_MCP_TRANSPORT = "http";
import("../index.js");
