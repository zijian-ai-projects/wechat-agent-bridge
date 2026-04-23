import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import { resolveAllowedRepoRoot } from "../config/git.js";
import { expandHome } from "../config/security.js";
import type { AgentMode } from "../backend/AgentBackend.js";
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import type { BridgeSession, ChatHistoryEntry, ProjectSession } from "../session/types.js";

export type CommandProjectManager = Pick<
  ProjectRuntimeManager,
  | "activeProjectAlias"
  | "listProjects"
  | "setActiveProject"
  | "interrupt"
  | "replacePrompt"
  | "clear"
  | "setMode"
  | "setModel"
  | "session"
>;

export interface CommandContext {
  text: string;
  session?: BridgeSession;
  projectManager?: CommandProjectManager;
  boundUserId: string;
  toUserId?: string;
  contextToken?: string;
  clearSession?: () => Promise<BridgeSession>;
  formatHistory?: (limit?: number) => string;
}

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export class CommandUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandUserError";
  }
}

const HELP_TEXT = `可用命令:
/help              显示帮助
/project [alias]   查看或切换当前项目
/interrupt [project]  中断项目任务
/replace [project] <prompt>  中断并替换项目提示词
/clear [project]   清除当前或指定项目会话
/status [project]  查看状态
/cwd [path]        查看项目目录，或切换到已配置项目目录
/model [project] [name]      查看或切换模型
/mode [project] [readonly|workspace|yolo]  切换运行模式
/history [project] [n]       查看最近 n 条对话

默认模式是 readonly。只有显式执行 /mode yolo 才会启用全权限。`;

export function handleHelp(): CommandResult {
  return { handled: true, reply: HELP_TEXT };
}

export async function handleProject(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const alias = args.trim();
  if (!alias) {
    return { handled: true, reply: formatProjectList(manager) };
  }
  if (!hasProject(manager, alias)) {
    return unknownProject(alias, manager);
  }
  const project = manager.setActiveProject(alias);
  return { handled: true, reply: `当前项目已切换为: ${project.alias}\n工作目录: ${project.cwd}` };
}

export async function handleInterrupt(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const alias = args.trim() || undefined;
  if (alias && !hasProject(manager, alias)) {
    return unknownProject(alias, manager);
  }
  await manager.interrupt(alias);
  return { handled: true, reply: `已中断项目: ${alias ?? manager.activeProjectAlias}` };
}

export async function handleReplace(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const parsed = splitProjectArg(manager, args);
  const prompt = parsed.rest.trim();
  if (!prompt) {
    return { handled: true, reply: "用法: /replace [project] <prompt>" };
  }
  await manager.replacePrompt({
    ...(parsed.alias ? { projectAlias: parsed.alias } : {}),
    prompt,
    toUserId: ctx.toUserId ?? ctx.boundUserId,
    contextToken: ctx.contextToken ?? "",
  });
  return { handled: true, reply: `已替换项目 ${parsed.alias ?? manager.activeProjectAlias} 的提示词。` };
}

export async function handleClear(ctx: CommandContext, args = ""): Promise<CommandResult> {
  if (ctx.projectManager) {
    const alias = parseOptionalProjectAlias(ctx.projectManager, args);
    if (alias instanceof Error) return unknownProject(alias.message, ctx.projectManager);
    await ctx.projectManager.clear(alias);
    return { handled: true, reply: `项目 ${alias ?? ctx.projectManager.activeProjectAlias} 会话已清除，下次消息将开始新 Codex 会话。` };
  }
  const session = requireSession(ctx);
  if (ctx.clearSession) {
    const next = await ctx.clearSession();
    Object.assign(session, next);
  } else {
    session.codexSessionId = undefined;
    session.codexThreadId = undefined;
    session.history = [];
    session.state = "idle";
  }
  return { handled: true, reply: "会话已清除，下次消息将开始新 Codex 会话。" };
}

export async function handleCwd(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (ctx.projectManager) {
    return handleProjectCwd(ctx.projectManager, args);
  }
  const session = requireSession(ctx);
  if (!args.trim()) {
    return {
      handled: true,
      reply: `当前工作目录: ${session.cwd}\n允许根目录:\n${session.allowlistRoots.map((root) => `- ${root}`).join("\n")}`,
    };
  }
  try {
    session.cwd = await resolveAllowedRepoRoot(args, session.allowlistRoots);
    return { handled: true, reply: `工作目录已切换为: ${session.cwd}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `无法切换目录: ${message}` };
  }
}

export async function handleModel(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (ctx.projectManager) {
    return handleProjectModel(ctx.projectManager, args);
  }
  const session = requireSession(ctx);
  if (!args.trim()) {
    return { handled: true, reply: `当前模型: ${session.model ?? "Codex 默认"}\n用法: /model <name>` };
  }
  session.model = args.trim();
  return { handled: true, reply: `模型已切换为: ${session.model ?? "Codex 默认"}` };
}

const MODES: AgentMode[] = ["readonly", "workspace", "yolo"];

export async function handleMode(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (ctx.projectManager) {
    return handleProjectMode(ctx.projectManager, args);
  }
  const session = requireSession(ctx);
  if (!args.trim()) {
    return {
      handled: true,
      reply: `当前模式: ${session.mode}\n可用模式: readonly, workspace, yolo\nreadonly 为默认安全模式，yolo 为危险全权限模式。`,
    };
  }
  const mode = args.trim() as AgentMode;
  if (!MODES.includes(mode)) {
    return { handled: true, reply: `未知模式: ${args}\n可用: ${MODES.join(", ")}` };
  }
  session.mode = mode;
  const warning = mode === "yolo" ? "\n危险: yolo 会绕过 Codex sandbox 和审批，只应在你信任任务与工作目录时使用。" : "";
  return { handled: true, reply: `模式已切换为: ${mode}${warning}` };
}

export async function handleStatus(ctx: CommandContext, args = ""): Promise<CommandResult> {
  if (ctx.projectManager) {
    return handleProjectStatus(ctx, args);
  }
  const session = requireSession(ctx);
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

export async function handleHistory(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (ctx.projectManager) {
    return handleProjectHistory(ctx.projectManager, args);
  }
  const limit = args.trim() ? Number.parseInt(args, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { handled: true, reply: "用法: /history [n]，n 必须是正整数。" };
  }
  if (ctx.formatHistory) {
    return { handled: true, reply: ctx.formatHistory(limit) };
  }
  const session = requireSession(ctx);
  const lines = session.history.slice(-Math.min(limit, 100)).map((entry) => {
    const role = entry.role === "user" ? "用户" : "Codex";
    return `[${entry.timestamp}] ${role}:\n${entry.content}`;
  });
  return { handled: true, reply: lines.length > 0 ? lines.join("\n\n") : "暂无对话记录" };
}

export function handleUnknown(command: string): CommandResult {
  return { handled: true, reply: `未知命令: /${command}\n输入 /help 查看可用命令。` };
}

function requireSession(ctx: CommandContext): BridgeSession {
  if (!ctx.session) {
    throw new Error("Command requires a session.");
  }
  return ctx.session;
}

function requireProjectManager(ctx: CommandContext): CommandProjectManager {
  if (!ctx.projectManager) {
    throw new CommandUserError("当前会话不支持项目命令。");
  }
  return ctx.projectManager;
}

function formatProjectList(manager: CommandProjectManager): string {
  return [
    "项目列表:",
    ...manager.listProjects().map((project) => `${project.active ? "*" : " "} ${project.alias} - ${project.cwd}`),
    `当前项目: ${manager.activeProjectAlias}`,
  ].join("\n");
}

function hasProject(manager: CommandProjectManager, alias: string): boolean {
  return manager.listProjects().some((project) => project.alias === alias);
}

function unknownProject(alias: string, manager: CommandProjectManager): CommandResult {
  return {
    handled: true,
    reply: `未知项目: ${alias}\n可用项目: ${manager.listProjects().map((project) => project.alias).join(", ")}`,
  };
}

function parseOptionalProjectAlias(manager: CommandProjectManager, args: string): string | undefined | Error {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  if (hasProject(manager, trimmed)) return trimmed;
  return new Error(trimmed);
}

function splitProjectArg(manager: CommandProjectManager, args: string): { alias?: string; rest: string; first?: string; afterFirst: string } {
  const trimmedStart = args.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmedStart);
  if (!match) return { rest: "", afterFirst: "" };
  const [, first, afterFirst] = match;
  if (hasProject(manager, first)) {
    return { alias: first, rest: afterFirst, first, afterFirst };
  }
  return { rest: trimmedStart, first, afterFirst };
}

function splitProjectPositionArg(
  manager: CommandProjectManager,
  args: string,
): { alias?: string; rest: string; unknownAlias?: string } {
  const trimmedStart = args.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmedStart);
  if (!match) return { rest: "" };
  const [, first, afterFirst] = match;
  if (hasProject(manager, first)) {
    return { alias: first, rest: afterFirst };
  }
  if (afterFirst.trim()) {
    return { unknownAlias: first, rest: afterFirst };
  }
  return { rest: trimmedStart };
}

function splitFirstArg(args: string): { first?: string; afterFirst: string; rest: string } {
  const trimmedStart = args.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmedStart);
  if (!match) return { afterFirst: "", rest: "" };
  const [, first, afterFirst] = match;
  return { first, afterFirst, rest: trimmedStart };
}

function parseProjectModeArg(
  manager: CommandProjectManager,
  args: string,
): { alias?: string; modeArg: string; unknownAlias?: string } {
  const parsed = splitFirstArg(args);
  if (!parsed.first) return { modeArg: "" };

  const afterFirst = parsed.afterFirst.trim();
  if (!afterFirst && MODES.includes(parsed.first as AgentMode)) {
    return { modeArg: parsed.first };
  }
  if (hasProject(manager, parsed.first)) {
    return { alias: parsed.first, modeArg: afterFirst };
  }
  if (afterFirst) {
    return { modeArg: afterFirst, unknownAlias: parsed.first };
  }
  return { modeArg: parsed.rest.trim() };
}

function parseProjectHistoryArg(
  manager: CommandProjectManager,
  args: string,
): { alias?: string; limitText: string; unknownAlias?: string } {
  const parsed = splitFirstArg(args);
  if (!parsed.first) return { limitText: "" };

  const afterFirst = parsed.afterFirst.trim();
  if (!afterFirst && isPositiveIntegerText(parsed.first)) {
    return { limitText: parsed.first };
  }
  if (hasProject(manager, parsed.first)) {
    return { alias: parsed.first, limitText: afterFirst };
  }
  if (afterFirst) {
    return { limitText: afterFirst, unknownAlias: parsed.first };
  }
  return { limitText: parsed.rest.trim() };
}

function isPositiveIntegerText(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function normalizeCommandPath(input: string): string {
  const expanded = expandHome(input.trim());
  return isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded);
}

async function handleProjectCwd(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const input = args.trim();
  if (!input) {
    const active = await manager.session();
    return {
      handled: true,
      reply: [
        `当前项目: ${manager.activeProjectAlias}`,
        `当前工作目录: ${active.cwd}`,
        "已配置项目:",
        ...manager.listProjects().map((project) => `${project.active ? "*" : " "} ${project.alias} - ${project.cwd}`),
      ].join("\n"),
    };
  }

  let resolvedInput: string;
  try {
    resolvedInput = await realpath(normalizeCommandPath(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `无法切换目录: ${message}` };
  }

  for (const project of manager.listProjects()) {
    let projectCwd: string;
    try {
      projectCwd = await realpath(normalizeCommandPath(project.cwd));
    } catch {
      continue;
    }
    if (projectCwd === resolvedInput) {
      manager.setActiveProject(project.alias);
      return { handled: true, reply: `当前项目已切换为: ${project.alias}\n工作目录: ${project.cwd}` };
    }
  }
  return { handled: true, reply: `未配置的项目目录: ${resolvedInput}\n/cwd 只能切换到已配置项目的 cwd。` };
}

async function handleProjectModel(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const parsed = splitProjectPositionArg(manager, args);
  if (parsed.unknownAlias) return unknownProject(parsed.unknownAlias, manager);
  const alias = parsed.alias;
  const modelArg = alias ? parsed.rest : args;
  if (!modelArg.trim()) {
    const session = await manager.session(alias);
    return {
      handled: true,
      reply: `当前项目: ${alias ?? manager.activeProjectAlias}\n当前模型: ${session.model ?? "Codex 默认"}\n用法: /model [project] <name>`,
    };
  }
  const session = await manager.setModel(alias, modelArg);
  return { handled: true, reply: `项目 ${session.projectAlias} 模型已切换为: ${session.model ?? "Codex 默认"}` };
}

async function handleProjectMode(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const parsed = parseProjectModeArg(manager, args);
  if (parsed.unknownAlias) return unknownProject(parsed.unknownAlias, manager);
  const alias = parsed.alias;
  const modeArg = parsed.modeArg.trim();
  if (!modeArg) {
    const session = await manager.session(alias);
    return {
      handled: true,
      reply: `当前项目: ${alias ?? manager.activeProjectAlias}\n当前模式: ${session.mode}\n可用模式: readonly, workspace, yolo\nreadonly 为默认安全模式，yolo 为危险全权限模式。`,
    };
  }
  if (!MODES.includes(modeArg as AgentMode)) {
    return { handled: true, reply: `未知模式: ${modeArg}\n可用: ${MODES.join(", ")}` };
  }
  const session = await manager.setMode(alias, modeArg);
  const warning = session.mode === "yolo" ? "\n危险: yolo 会绕过 Codex sandbox 和审批，只应在你信任任务与工作目录时使用。" : "";
  return { handled: true, reply: `项目 ${session.projectAlias} 模式已切换为: ${session.mode}${warning}` };
}

async function handleProjectStatus(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const alias = args.trim();
  if (alias) {
    if (!hasProject(manager, alias)) return unknownProject(alias, manager);
    const session = await manager.session(alias);
    return { handled: true, reply: formatProjectSessionStatus(ctx.boundUserId, session) };
  }
  const lines = ["项目状态", `用户: ${ctx.boundUserId}`, `当前项目: ${manager.activeProjectAlias}`];
  for (const project of manager.listProjects()) {
    const session = await manager.session(project.alias);
    lines.push(
      `${project.active ? "*" : " "} ${project.alias} | ${session.state} | ${session.mode} | ${session.model ?? "Codex 默认"} | ${session.cwd}`,
    );
  }
  return { handled: true, reply: lines.join("\n") };
}

async function handleProjectHistory(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const parsed = parseProjectHistoryArg(manager, args);
  if (parsed.unknownAlias) return unknownProject(parsed.unknownAlias, manager);
  const alias = parsed.alias;
  const limitText = parsed.limitText.trim();
  const limit = limitText ? Number.parseInt(limitText, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0 || (limitText && String(limit) !== limitText)) {
    return { handled: true, reply: "用法: /history [project] [n]，n 必须是正整数。" };
  }
  const session = await manager.session(alias);
  return { handled: true, reply: `项目 ${session.projectAlias} 历史:\n${formatHistoryEntries(session.history, limit)}` };
}

function formatProjectSessionStatus(boundUserId: string, session: ProjectSession): string {
  return [
    "项目会话状态",
    `项目: ${session.projectAlias}`,
    `用户: ${boundUserId}`,
    `状态: ${session.state}`,
    `工作目录: ${session.cwd}`,
    `模式: ${session.mode}`,
    `模型: ${session.model ?? "Codex 默认"}`,
    `Codex session: ${session.codexSessionId ?? "无"}`,
    `历史条数: ${session.history.length}`,
  ].join("\n");
}

function formatHistoryEntries(history: ChatHistoryEntry[], limit: number): string {
  const entries = history.slice(-Math.min(limit, 100));
  if (entries.length === 0) return "暂无对话记录";
  return entries
    .map((entry) => {
      const role = entry.role === "user" ? "用户" : "Codex";
      return `[${new Date(entry.timestamp).toLocaleString("zh-CN")}] ${role}:\n${entry.content}`;
    })
    .join("\n\n");
}
