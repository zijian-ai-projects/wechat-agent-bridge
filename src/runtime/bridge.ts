import { realpath } from "node:fs/promises";

import { CodexExecBackend } from "../backend/CodexExecBackend.js";
import type { AgentBackend } from "../backend/AgentBackend.js";
import { loadLatestAccount, type AccountData } from "../config/accounts.js";
import { loadConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { FileSessionStore } from "../session/sessionStore.js";
import type { BridgeSession } from "../session/types.js";
import { WeChatApi } from "../wechat/api.js";
import { WeChatMonitor } from "../wechat/monitor.js";
import { createWechatSender, type WeChatSender } from "../wechat/sender.js";
import type { WeixinMessage } from "../wechat/types.js";
import { runPreflight } from "./preflight.js";
import { AgentService } from "../core/AgentService.js";
import { BridgeService } from "../core/BridgeService.js";
import type { SessionStorePort } from "../core/types.js";

export async function runBridge(backend: AgentBackend = new CodexExecBackend()): Promise<void> {
  const config = loadConfig();
  const preflight = await runPreflight(config);
  logger.info("Codex preflight passed", { loginState: preflight.login.state, cwd: preflight.cwd });
  const account = loadLatestAccount();
  if (!account) {
    throw new Error("未找到微信账号，请先运行 npm run setup");
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

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sender = createWechatSender(api, account.accountId);
  const bridgeService = new BridgeService({
    account,
    session,
    sessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: config.streamIntervalMs,
    extraWritableRoots,
  });
  const monitor = new WeChatMonitor(api, {
    onMessage: (message) => bridgeService.handleMessage(message),
    onSessionExpired: () => {
      logger.warn("WeChat session expired");
      console.error("微信登录已过期，请重新运行 npm run setup");
    },
  });

  const shutdown = async () => {
    monitor.stop();
    await backend.interrupt(account.boundUserId);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  logger.info("Daemon started", { accountId: account.accountId, boundUserId: account.boundUserId });
  console.log(`wechat-agent-bridge started. Bound user: ${account.boundUserId}`);
  await monitor.run();
}

async function handleMessageForTestCompat(
  message: WeixinMessage,
  account: AccountData,
  session: BridgeSession,
  sessionStore: SessionStorePort,
  sender: WeChatSender,
  backend: AgentBackend,
  streamIntervalMs: number,
  extraWritableRoots: string[] = [],
): Promise<void> {
  const service = new BridgeService({
    account,
    session,
    sessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs,
    extraWritableRoots,
  });
  await service.handleMessage(message);
}

export const handleMessageForTest = handleMessageForTestCompat;
