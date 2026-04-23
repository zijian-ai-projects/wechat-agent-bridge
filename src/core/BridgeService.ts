import { routeCommand } from "../commands/router.js";
import type { CommandProjectManager } from "../commands/handlers.js";
import type { AccountData } from "../config/accounts.js";
import { isDirectBoundUserMessage } from "../config/security.js";
import { MessageItemType, type WeixinMessage } from "../wechat/types.js";
import type { ProjectRuntimeManager } from "./ProjectRuntimeManager.js";
import type { TextSender } from "./types.js";

export type BridgeProjectManager = CommandProjectManager & Pick<ProjectRuntimeManager, "runPrompt">;

export interface BridgeServiceOptions {
  account: AccountData;
  projectManager: BridgeProjectManager;
  sender: TextSender;
}

export class BridgeService {
  private readonly account: AccountData;
  private readonly projectManager: BridgeProjectManager;
  private readonly sender: TextSender;

  constructor(options: BridgeServiceOptions) {
    this.account = options.account;
    this.projectManager = options.projectManager;
    this.sender = options.sender;
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
    const { rawText, normalizedText } = extractBridgeMessageText(message);
    if (!normalizedText) {
      await this.sender.sendText(fromUserId, contextToken, "暂只支持文本消息。");
      return;
    }

    if (rawText.trimStart().startsWith("/")) {
      const result = await routeCommand({
        text: rawText,
        projectManager: this.projectManager,
        boundUserId: this.account.boundUserId,
        toUserId: fromUserId,
        contextToken,
      });
      if (result.handled && result.reply) {
        await this.sender.sendText(fromUserId, contextToken, result.reply);
      }
      return;
    }

    const targeted = parseTargetedPrompt(rawText);
    await this.projectManager.runPrompt({
      ...(targeted ? { projectAlias: targeted.projectAlias } : {}),
      prompt: targeted?.prompt ?? rawText,
      toUserId: fromUserId,
      contextToken,
    });
  }
}

export function parseTargetedPrompt(text: string): { projectAlias: string; prompt: string } | undefined {
  const match = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match) return undefined;
  return { projectAlias: match[1], prompt: match[2].trim() };
}

function extractBridgeMessageText(message: WeixinMessage): { rawText: string; normalizedText: string } {
  const parts = (message.item_list ?? [])
    .map((item) => {
      if (item.type === MessageItemType.TEXT) return item.text_item?.text;
      if (item.type === MessageItemType.VOICE) return item.voice_item?.voice_text;
      return undefined;
    })
    .filter((text): text is string => Boolean(text?.trim()));

  const rawText = parts.join("\n");
  return { rawText, normalizedText: rawText.trim() };
}
