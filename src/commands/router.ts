import {
  handleClear,
  handleCwd,
  handleHelp,
  handleHistory,
  handleMode,
  handleModel,
  handleStatus,
  handleUnknown,
  type CommandContext,
  type CommandResult,
} from "./handlers.js";

export type { CommandContext, CommandResult } from "./handlers.js";

export async function routeCommand(ctx: CommandContext): Promise<CommandResult> {
  const text = ctx.text.trim();
  if (!text.startsWith("/")) return { handled: false };

  const spaceIndex = text.indexOf(" ");
  const command = (spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  switch (command) {
    case "help":
      return handleHelp();
    case "clear":
      return handleClear(ctx);
    case "status":
      return handleStatus(ctx);
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
}
