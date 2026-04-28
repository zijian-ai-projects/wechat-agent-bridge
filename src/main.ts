#!/usr/bin/env node
import { runDaemonCommand } from "./daemon/manager.js";
import { runAttach } from "./ipc/AttachClient.js";
import { runBridge } from "./runtime/bridge.js";
import { runSetup } from "./setup/setup.js";
import { logger } from "./logging/logger.js";

async function main(): Promise<void> {
  const [command, subcommand] = process.argv.slice(2);
  if (command === "setup") {
    await runSetup();
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(subcommand);
    return;
  }
  if (command === "attach") {
    await runAttach({ project: subcommand });
    return;
  }
  if (!command || command === "start") {
    await runBridge();
    return;
  }
  console.log("Usage: npm run setup | npm run start | npm run attach | npm run mcp | npm run daemon -- start|stop|status|logs|restart | wechat-agent-bridge attach [project]");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Fatal error", { error: message });
  console.error(message);
  process.exit(1);
});
