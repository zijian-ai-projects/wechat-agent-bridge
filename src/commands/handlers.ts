import { resolveAllowedRepoRoot } from "../config/git.js";
import type { AgentMode } from "../backend/AgentBackend.js";
import type { BridgeSession } from "../session/types.js";

export interface CommandContext {
  text: string;
  session: BridgeSession;
  boundUserId: string;
  clearSession?: () => Promise<BridgeSession>;
  formatHistory?: (limit?: number) => string;
}

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

const HELP_TEXT = `可用命令:
/help              显示帮助
/clear             清除当前会话
/status            查看状态
/cwd [path]        查看或切换工作目录
/model [name]      查看或切换模型
/mode [readonly|workspace|yolo]  切换运行模式
/history [n]       查看最近 n 条对话

默认模式是 readonly。只有显式执行 /mode yolo 才会启用全权限。`;

export function handleHelp(): CommandResult {
  return { handled: true, reply: HELP_TEXT };
}

export async function handleClear(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.clearSession) {
    const next = await ctx.clearSession();
    Object.assign(ctx.session, next);
  } else {
    ctx.session.codexSessionId = undefined;
    ctx.session.codexThreadId = undefined;
    ctx.session.history = [];
    ctx.session.state = "idle";
  }
  return { handled: true, reply: "会话已清除，下次消息将开始新 Codex 会话。" };
}

export async function handleCwd(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!args) {
    return {
      handled: true,
      reply: `当前工作目录: ${ctx.session.cwd}\n允许根目录:\n${ctx.session.allowlistRoots.map((root) => `- ${root}`).join("\n")}`,
    };
  }
  try {
    ctx.session.cwd = await resolveAllowedRepoRoot(args, ctx.session.allowlistRoots);
    return { handled: true, reply: `工作目录已切换为: ${ctx.session.cwd}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `无法切换目录: ${message}` };
  }
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { handled: true, reply: `当前模型: ${ctx.session.model ?? "Codex 默认"}\n用法: /model <name>` };
  }
  ctx.session.model = args;
  return { handled: true, reply: `模型已切换为: ${args}` };
}

const MODES: AgentMode[] = ["readonly", "workspace", "yolo"];

export function handleMode(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return {
      handled: true,
      reply: `当前模式: ${ctx.session.mode}\n可用模式: readonly, workspace, yolo\nreadonly 为默认安全模式，yolo 为危险全权限模式。`,
    };
  }
  const mode = args.trim() as AgentMode;
  if (!MODES.includes(mode)) {
    return { handled: true, reply: `未知模式: ${args}\n可用: ${MODES.join(", ")}` };
  }
  ctx.session.mode = mode;
  const warning = mode === "yolo" ? "\n危险: yolo 会绕过 Codex sandbox 和审批，只应在你信任任务与工作目录时使用。" : "";
  return { handled: true, reply: `模式已切换为: ${mode}${warning}` };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const session = ctx.session;
  return {
    handled: true,
    reply: [
      "会话状态",
      `用户: ${ctx.boundUserId}`,
      `状态: ${session.state}`,
      `工作目录: ${session.cwd}`,
      `模式: ${session.mode}`,
      `模型: ${session.model ?? "Codex 默认"}`,
      `Codex session: ${session.codexSessionId ?? "无"}`,
      `历史条数: ${session.history.length}`,
    ].join("\n"),
  };
}

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? Number.parseInt(args, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { handled: true, reply: "用法: /history [n]，n 必须是正整数。" };
  }
  if (ctx.formatHistory) {
    return { handled: true, reply: ctx.formatHistory(limit) };
  }
  const lines = ctx.session.history.slice(-Math.min(limit, 100)).map((entry) => {
    const role = entry.role === "user" ? "用户" : "Codex";
    return `[${entry.timestamp}] ${role}:\n${entry.content}`;
  });
  return { handled: true, reply: lines.length > 0 ? lines.join("\n\n") : "暂无对话记录" };
}

export function handleUnknown(command: string): CommandResult {
  return { handled: true, reply: `未知命令: /${command}\n输入 /help 查看可用命令。` };
}
