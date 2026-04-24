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
  CommandUserError,
  type CommandContext,
  type CommandResult,
} from "./handlers.js";
import { logger } from "../logging/logger.js";

export type { CommandContext, CommandResult } from "./handlers.js";
export { CommandUserError } from "./handlers.js";

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
        return await handleHelp(args);
      case "project":
        return await handleProject(ctx, args);
      case "interrupt":
        return await handleInterrupt(ctx, args);
      case "replace":
        return await handleReplace(ctx, args);
      case "clear":
        return await handleClear(ctx, args);
      case "status":
        return await handleStatus(ctx, args);
      case "cwd":
        return await handleCwd(ctx, args);
      case "model":
        return await handleModel(ctx, args);
      case "mode":
        return await handleMode(ctx, args);
      case "history":
        return await handleHistory(ctx, args);
      default:
        return handleUnknown(command);
    }
  } catch (error) {
    if (error instanceof CommandUserError) {
      return { handled: true, reply: error.message };
    }
    const errorDetails =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
    logger.error("Command execution failed", { command, error: errorDetails });
    return { handled: true, reply: "命令执行失败，请查看日志。" };
  }
}
