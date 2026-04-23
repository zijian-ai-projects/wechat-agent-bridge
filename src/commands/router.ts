import {
  handleClear,
  handleCwd,
  handleHelp,
  handleHistory,
  handleInterrupt,
  handleMode,
  handleModel,
  handleProject,
  handleReplace,
  handleStatus,
  handleUnknown,
  type CommandContext,
  type CommandResult,
} from "./handlers.js";

export type { CommandContext, CommandResult } from "./handlers.js";

export async function routeCommand(ctx: CommandContext): Promise<CommandResult> {
  const text = ctx.text.trimStart();
  if (!text.startsWith("/")) return { handled: false };

  const commandMatch = /^\/(\S+)([\s\S]*)$/.exec(text);
  if (!commandMatch) return { handled: false };
  const command = commandMatch[1].toLowerCase();
  const args = commandMatch[2].replace(/^\s/, "");

  try {
    switch (command) {
      case "help":
        return handleHelp();
      case "project":
        return handleProject(ctx, args);
      case "interrupt":
        return handleInterrupt(ctx, args);
      case "replace":
        return handleReplace(ctx, args);
      case "clear":
        return handleClear(ctx, args);
      case "status":
        return handleStatus(ctx, args);
      case "cwd":
        return handleCwd(ctx, args);
      case "model":
        return handleModel(ctx, args);
      case "mode":
        return handleMode(ctx, args);
      case "history":
        return handleHistory(ctx, args);
      default:
        return handleUnknown(command);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `命令执行失败: ${message}` };
  }
}
