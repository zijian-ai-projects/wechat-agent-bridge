#!/usr/bin/env node
import { logger } from "./logging/logger.js";
import { loadBridgeMcpContext } from "./mcp/context.js";
import { runBridgeMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const context = await loadBridgeMcpContext();
  await runBridgeMcpServer(context);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("MCP server fatal error", { error: message });
  console.error(message);
  process.exit(1);
});
