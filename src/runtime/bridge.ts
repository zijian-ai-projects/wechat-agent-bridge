import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { CodexExecBackend } from "../backend/CodexExecBackend.js";
import type { AgentBackend } from "../backend/AgentBackend.js";
import { loadLatestAccount, type AccountData } from "../config/accounts.js";
import { loadConfig } from "../config/config.js";
import { isDirectBoundUserMessage } from "../config/security.js";
import { logger } from "../logging/logger.js";
import { routeCommand } from "../commands/router.js";
import { FileSessionStore } from "../session/sessionStore.js";
import type { BridgeSession } from "../session/types.js";
import { StreamBuffer } from "./streamBuffer.js";
import { WeChatApi } from "../wechat/api.js";
import { extractMessageText } from "../wechat/message.js";
import { WeChatMonitor } from "../wechat/monitor.js";
import { createWechatSender, type WeChatSender } from "../wechat/sender.js";
import type { WeixinMessage } from "../wechat/types.js";
import { extractSessionId } from "../backend/codexEvents.js";
import { runPreflight } from "./preflight.js";

interface SessionStoreLike {
  save(session: BridgeSession): Promise<void>;
  clear(userId: string, defaults: { cwd: string; allowlistRoots: string[] }): Promise<BridgeSession>;
  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void;
  formatHistory(session: BridgeSession, limit?: number): string;
}

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
  const monitor = new WeChatMonitor(api, {
    onMessage: (message) =>
      handleMessage(message, account, session, sessionStore, sender, backend, config.streamIntervalMs, extraWritableRoots),
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
  console.log(`wechat-codex-bridge started. Bound user: ${account.boundUserId}`);
  await monitor.run();
}

async function handleMessage(
  message: WeixinMessage,
  account: AccountData,
  session: BridgeSession,
  sessionStore: SessionStoreLike,
  sender: WeChatSender,
  backend: AgentBackend,
  streamIntervalMs: number,
  extraWritableRoots: string[] = [],
): Promise<void> {
  if (
    !isDirectBoundUserMessage({
      fromUserId: message.from_user_id,
      boundUserId: account.boundUserId,
      messageType: message.message_type,
    })
  ) {
    return;
  }

  const fromUserId = message.from_user_id!;
  const contextToken = message.context_token ?? "";
  const text = extractMessageText(message);
  if (!text) {
    await sender.sendText(fromUserId, contextToken, "暂只支持文本消息。");
    return;
  }

  const isCommand = text.trim().startsWith("/");
  if (session.state === "processing" && !isCommand) {
    await backend.interrupt(account.boundUserId);
    session.state = "idle";
    await sessionStore.save(session);
    await sender.sendText(fromUserId, contextToken, "已中断上一轮 Codex 任务，开始处理新消息。");
  }

  if (isCommand) {
    if (text.trim().startsWith("/clear")) {
      await backend.interrupt(account.boundUserId);
    }
    const result = await routeCommand({
      text,
      session,
      boundUserId: account.boundUserId,
      clearSession: () =>
        sessionStore.clear(account.boundUserId, {
          cwd: session.cwd,
          allowlistRoots: session.allowlistRoots,
        }),
      formatHistory: (limit) => sessionStore.formatHistory(session, limit),
    });
    if (text.trim().startsWith("/clear")) {
      session.codexSessionId = undefined;
      session.codexThreadId = undefined;
      session.activeTurnId = undefined;
      session.state = "idle";
    }
    await sessionStore.save(session);
    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
    }
    return;
  }

  await runCodexTurn(text, fromUserId, contextToken, session, sessionStore, sender, backend, streamIntervalMs, extraWritableRoots);
}

export const handleMessageForTest = handleMessage;

async function runCodexTurn(
  text: string,
  fromUserId: string,
  contextToken: string,
  session: BridgeSession,
  sessionStore: SessionStoreLike,
  sender: WeChatSender,
  backend: AgentBackend,
  streamIntervalMs: number,
  extraWritableRoots: string[],
): Promise<void> {
  const turnId = randomUUID();
  session.state = "processing";
  session.activeTurnId = turnId;
  sessionStore.addHistory(session, "user", text);
  await sessionStore.save(session);

  const stream = new StreamBuffer({
    intervalMs: streamIntervalMs,
    send: (chunk) => sender.sendText(fromUserId, contextToken, chunk),
  });

  const request = {
    userId: session.userId,
    prompt: text,
    cwd: session.cwd,
    mode: session.mode,
    model: session.model,
    codexSessionId: session.codexSessionId,
    extraWritableRoots,
  };

  try {
    const callbacks = {
      onEvent: async (event: unknown, formatted?: string) => {
        if (session.activeTurnId !== turnId) return;
        const id = extractSessionId(event as never);
        if (id) {
          session.codexSessionId = id;
          session.codexThreadId = id;
        }
        if (formatted) await stream.append(formatted);
      },
    };
    let result = request.codexSessionId
      ? await backend.resumeTurn(request, callbacks)
      : await backend.startTurn(request, callbacks);

    if (!result.interrupted && request.codexSessionId && !result.text && !result.codexSessionId) {
      session.codexSessionId = undefined;
      result = await backend.startTurn({ ...request, codexSessionId: undefined }, callbacks);
    }

    await stream.flush(true);
    if (session.activeTurnId !== turnId) return;
    if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
    if (result.codexThreadId) session.codexThreadId = result.codexThreadId;

    if (result.interrupted) return;
    if (result.text) sessionStore.addHistory(session, "assistant", result.text);
    if (!result.text) await sender.sendText(fromUserId, contextToken, "Codex 本轮无文本返回。");
  } catch (error) {
    if (session.activeTurnId !== turnId) return;
    logger.error("Codex turn failed", { error: error instanceof Error ? error.message : String(error) });
    await sender.sendText(fromUserId, contextToken, `Codex 处理失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session.activeTurnId === turnId) {
      session.state = "idle";
      session.activeTurnId = undefined;
      await sessionStore.save(session);
    }
  }
}
