import { randomUUID } from "node:crypto";

import { extractSessionId } from "../backend/codexEvents.js";
import { routeCommand } from "../commands/router.js";
import type { AccountData } from "../config/accounts.js";
import { isDirectBoundUserMessage } from "../config/security.js";
import { logger } from "../logging/logger.js";
import type { BridgeSession } from "../session/types.js";
import { StreamBuffer } from "../runtime/streamBuffer.js";
import { extractMessageText } from "../wechat/message.js";
import type { WeixinMessage } from "../wechat/types.js";
import type { AgentService } from "./AgentService.js";
import type { SessionStorePort, TextSender } from "./types.js";

export interface BridgeServiceOptions {
  account: AccountData;
  session: BridgeSession;
  sessionStore: SessionStorePort;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots?: string[];
}

export class BridgeService {
  private readonly account: AccountData;
  private readonly session: BridgeSession;
  private readonly sessionStore: SessionStorePort;
  private readonly sender: TextSender;
  private readonly agentService: AgentService;
  private readonly streamIntervalMs: number;
  private readonly extraWritableRoots: string[];

  constructor(options: BridgeServiceOptions) {
    this.account = options.account;
    this.session = options.session;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
  }

  async handleMessage(message: WeixinMessage): Promise<void> {
    if (
      !isDirectBoundUserMessage({
        fromUserId: message.from_user_id,
        boundUserId: this.account.boundUserId,
        messageType: message.message_type,
      })
    ) {
      return;
    }

    const fromUserId = message.from_user_id!;
    const contextToken = message.context_token ?? "";
    const text = extractMessageText(message);
    if (!text) {
      await this.sender.sendText(fromUserId, contextToken, "暂只支持文本消息。");
      return;
    }

    const isCommand = text.trim().startsWith("/");
    if (this.session.state === "processing" && !isCommand) {
      await this.agentService.interrupt(this.account.boundUserId);
      this.session.state = "idle";
      await this.sessionStore.save(this.session);
      await this.sender.sendText(fromUserId, contextToken, "已中断上一轮 Codex 任务，开始处理新消息。");
    }

    if (isCommand) {
      await this.handleCommand(text, fromUserId, contextToken);
      return;
    }

    await this.runAgentTurn(text, fromUserId, contextToken);
  }

  private async handleCommand(text: string, fromUserId: string, contextToken: string): Promise<void> {
    if (text.trim().startsWith("/clear")) {
      await this.agentService.interrupt(this.account.boundUserId);
    }
    const result = await routeCommand({
      text,
      session: this.session,
      boundUserId: this.account.boundUserId,
      clearSession: () =>
        this.sessionStore.clear(this.account.boundUserId, {
          cwd: this.session.cwd,
          allowlistRoots: this.session.allowlistRoots,
        }),
      formatHistory: (limit) => this.sessionStore.formatHistory(this.session, limit),
    });
    if (text.trim().startsWith("/clear")) {
      this.session.codexSessionId = undefined;
      this.session.codexThreadId = undefined;
      this.session.activeTurnId = undefined;
      this.session.state = "idle";
    }
    await this.sessionStore.save(this.session);
    if (result.handled && result.reply) {
      await this.sender.sendText(fromUserId, contextToken, result.reply);
    }
  }

  private async runAgentTurn(text: string, fromUserId: string, contextToken: string): Promise<void> {
    const turnId = randomUUID();
    this.session.state = "processing";
    this.session.activeTurnId = turnId;
    this.sessionStore.addHistory(this.session, "user", text);
    await this.sessionStore.save(this.session);

    const stream = new StreamBuffer({
      intervalMs: this.streamIntervalMs,
      send: (chunk) => this.sender.sendText(fromUserId, contextToken, chunk),
    });

    const request = {
      userId: this.session.userId,
      prompt: text,
      cwd: this.session.cwd,
      mode: this.session.mode,
      model: this.session.model,
      codexSessionId: this.session.codexSessionId,
      extraWritableRoots: this.extraWritableRoots,
    };

    try {
      const result = await this.agentService.runTurn(request, {
        onEvent: async (event: unknown, formatted?: string) => {
          if (this.session.activeTurnId !== turnId) return;
          const id = extractSessionId(event as never);
          if (id) {
            this.session.codexSessionId = id;
            this.session.codexThreadId = id;
          }
          if (formatted) await stream.append(formatted);
        },
      });

      await stream.flush(true);
      if (this.session.activeTurnId !== turnId) return;
      if (result.clearedStaleSession) {
        this.session.codexSessionId = undefined;
        this.session.codexThreadId = undefined;
      }
      if (result.codexSessionId) this.session.codexSessionId = result.codexSessionId;
      if (result.codexThreadId) this.session.codexThreadId = result.codexThreadId;

      if (result.interrupted) return;
      if (result.text) this.sessionStore.addHistory(this.session, "assistant", result.text);
      if (!result.text) await this.sender.sendText(fromUserId, contextToken, "Codex 本轮无文本返回。");
    } catch (error) {
      if (this.session.activeTurnId !== turnId) return;
      logger.error("Codex turn failed", { error: error instanceof Error ? error.message : String(error) });
      await this.sender.sendText(fromUserId, contextToken, `Codex 处理失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.session.activeTurnId === turnId) {
        this.session.state = "idle";
        this.session.activeTurnId = undefined;
        await this.sessionStore.save(this.session);
      }
    }
  }
}
