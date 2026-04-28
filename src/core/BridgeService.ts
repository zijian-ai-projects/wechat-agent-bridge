import { routeCommand } from "../commands/router.js";
import { formatProjectInitReply, type CommandModelService, type CommandProjectManager } from "../commands/handlers.js";
import type { AccountData } from "../config/accounts.js";
import { isDirectBoundUserMessage } from "../config/security.js";
import { MessageItemType, type WeixinMessage } from "../wechat/types.js";
import { ProjectInitRequiredError, type ProjectRuntimeManager } from "./ProjectRuntimeManager.js";
import type { TextSender } from "./types.js";

export type BridgeProjectManager = CommandProjectManager & Pick<ProjectRuntimeManager, "runPrompt">;

export interface BridgeServiceOptions {
  account: AccountData;
  projectManager: BridgeProjectManager;
  sender: TextSender;
  modelService?: CommandModelService;
}

export class BridgeService {
  private readonly account: AccountData;
  private readonly projectManager: BridgeProjectManager;
  private readonly sender: TextSender;
  private readonly modelService?: CommandModelService;

  constructor(options: BridgeServiceOptions) {
    this.account = options.account;
    this.projectManager = options.projectManager;
    this.sender = options.sender;
    this.modelService = options.modelService;
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
        modelService: this.modelService,
      });
      if (result.handled && result.reply) {
        await this.sender.sendText(fromUserId, contextToken, result.reply);
      }
      return;
    }

    const projects = await this.projectManager.listProjects();
    const targeted = parseTargetedPrompt(rawText);
    const activeProject = projects.find((item) => item.alias === this.projectManager.activeProjectAlias);
    if (!targeted && activeProject && !activeProject.ready) {
      await this.sender.sendText(fromUserId, contextToken, formatProjectInitReply(activeProject.alias));
      return;
    }
    if (targeted) {
      const project = projects.find((item) => item.alias === targeted.projectAlias);
      if (!project) {
        await this.sender.sendText(fromUserId, contextToken, formatUnknownProjectReply(projects, targeted.projectAlias));
        return;
      }
      if (!project.ready) {
        await this.sender.sendText(fromUserId, contextToken, formatProjectInitReply(project.alias));
        return;
      }
    }

    try {
      await this.projectManager.runPrompt({
        ...(targeted ? { projectAlias: targeted.projectAlias } : {}),
        prompt: targeted?.prompt ?? rawText,
        toUserId: fromUserId,
        contextToken,
        source: "wechat",
      });
    } catch (error) {
      if (error instanceof ProjectInitRequiredError) {
        await this.sender.sendText(fromUserId, contextToken, formatProjectInitReply(error.projectAlias));
        return;
      }
      throw error;
    }
  }
}

export function parseTargetedPrompt(text: string): { projectAlias: string; prompt: string } | undefined {
  const match = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match) return undefined;
  return { projectAlias: match[1], prompt: match[2].trim() };
}

function formatUnknownProjectReply(projects: Array<{ alias: string }>, alias: string): string {
  return `未知项目: ${alias}\n可用项目: ${projects.map((project) => project.alias).join(", ")}`;
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
