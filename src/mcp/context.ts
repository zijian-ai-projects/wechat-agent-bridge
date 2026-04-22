import { realpath } from "node:fs/promises";

import { CodexExecBackend } from "../backend/CodexExecBackend.js";
import type { AgentBackend } from "../backend/AgentBackend.js";
import { AgentService } from "../core/AgentService.js";
import { loadLatestAccount } from "../config/accounts.js";
import { loadConfig } from "../config/config.js";
import { FileSessionStore } from "../session/sessionStore.js";
import { runPreflight } from "../runtime/preflight.js";
import type { BridgeMcpContext } from "./tools/index.js";

export interface LoadMcpContextOptions {
  runPreflightChecks?: boolean;
}

export async function loadBridgeMcpContext(
  backend: AgentBackend = new CodexExecBackend(),
  options: LoadMcpContextOptions = {},
): Promise<BridgeMcpContext> {
  const config = loadConfig();
  const account = loadLatestAccount();
  if (!account) {
    return {
      account: null,
      session: null,
      sessionStore: null,
      agentService: new AgentService(backend),
    };
  }

  if (options.runPreflightChecks ?? true) {
    await runPreflight(config);
  }

  const defaultCwd = await realpath(config.defaultCwd);
  const allowlistRoots = await Promise.all(config.allowlistRoots.map((root) => realpath(root)));
  const extraWritableRoots = await Promise.all(config.extraWritableRoots.map((root) => realpath(root)));
  const sessionStore = new FileSessionStore();
  const session = await sessionStore.load(account.boundUserId, {
    cwd: defaultCwd,
    allowlistRoots,
    resetStaleProcessing: true,
  });
  await sessionStore.save(session);

  return {
    account,
    session,
    sessionStore,
    agentService: new AgentService(backend),
    extraWritableRoots,
  };
}
