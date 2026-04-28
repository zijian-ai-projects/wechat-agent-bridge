import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import { resolveAllowedRepoRoot } from "../config/git.js";
import { expandHome } from "../config/security.js";
import type { AgentMode } from "../backend/AgentBackend.js";
import { ModelService, type ModelCatalog, type ModelState } from "../core/ModelService.js";
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import type { BridgeSession, ChatHistoryEntry, ProjectSession } from "../session/types.js";
import { formatHelpDetail, formatHelpOverview } from "./helpCatalog.js";

export type CommandProjectManager = Pick<
  ProjectRuntimeManager,
  | "activeProjectAlias"
  | "listProjects"
  | "setActiveProject"
  | "initializeProject"
  | "interrupt"
  | "replacePrompt"
  | "clear"
  | "setMode"
  | "setModel"
  | "session"
>;

export type CommandModelService = Pick<ModelService, "describeSession" | "listModels">;

interface ProjectListItem {
  alias: string;
  cwd: string;
  ready: boolean;
  active: boolean;
}

export interface CommandContext {
  text: string;
  session?: BridgeSession;
  projectManager?: CommandProjectManager;
  boundUserId: string;
  toUserId?: string;
  contextToken?: string;
  clearSession?: () => Promise<BridgeSession>;
  formatHistory?: (limit?: number) => string;
  modelService?: CommandModelService;
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

export async function handleHelp(args = ""): Promise<CommandResult> {
  const target = args.trim().toLowerCase();
  if (!target) {
    return { handled: true, reply: formatHelpOverview() };
  }
  const detail = formatHelpDetail(target);
  return {
    handled: true,
    reply: detail ?? `未知命令: /${target}\n输入 /help 查看可用命令。`,
  };
}

export async function handleProject(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const trimmed = args.trim();
  const projects = await manager.listProjects();
  if (!trimmed) {
    return { handled: true, reply: formatProjectList(projects, manager.activeProjectAlias) };
  }
  const init = trimmed.endsWith(" --init");
  const alias = init ? trimmed.slice(0, -7).trim() : trimmed;
  const project = projects.find((item) => item.alias === alias);
  if (!project) {
    return unknownProjectFromProjects(alias, projects);
  }
  if (!project.ready && !init) {
    return { handled: true, reply: formatProjectInitReply(alias) };
  }
  const switched = project.ready ? await manager.setActiveProject(alias) : await manager.initializeProject(alias);
  return { handled: true, reply: `当前项目已切换为: ${switched.alias}\n工作目录: ${switched.cwd}` };
}

export async function handleInterrupt(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const alias = args.trim() || undefined;
  if (alias && !(await hasProject(manager, alias))) {
    return unknownProject(alias, manager);
  }
  await manager.interrupt(alias);
  return { handled: true, reply: `已中断项目: ${alias ?? manager.activeProjectAlias}` };
}

export async function handleReplace(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const parsed = await splitProjectArg(manager, args);
  const prompt = parsed.rest.trim();
  if (!prompt) {
    return { handled: true, reply: "用法: /replace [project] <prompt>" };
  }
  const projects = await manager.listProjects();
  const targetAlias = parsed.alias ?? manager.activeProjectAlias;
  const project = projects.find((item) => item.alias === targetAlias);
  if (!project) {
    return unknownProjectFromProjects(targetAlias, projects);
  }
  if (!project.ready) {
    return { handled: true, reply: formatProjectInitReply(project.alias) };
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
    const alias = await parseOptionalProjectAlias(ctx.projectManager, args);
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
    return handleProjectModel(ctx, args);
  }
  const session = requireSession(ctx);
  if (!args.trim()) {
    const state = await modelServiceFrom(ctx).describeSession(session);
    return { handled: true, reply: `${formatCurrentModelState(state)}\n用法: /model <name>` };
  }
  session.model = args.trim();
  return { handled: true, reply: `模型已切换为: ${session.model ?? "Codex 默认"}` };
}

export async function handleModels(ctx: CommandContext): Promise<CommandResult> {
  try {
    const catalog = await modelServiceFrom(ctx).listModels();
    return { handled: true, reply: formatModelCatalog(catalog) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `无法读取 Codex 模型目录: ${message}` };
  }
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
  const state = await modelServiceFrom(ctx).describeSession(session);
  return {
    handled: true,
    reply: [
      "会话状态",
      `用户: ${ctx.boundUserId}`,
      `状态: ${session.state}`,
      `工作目录: ${session.cwd}`,
      `模式: ${session.mode}`,
      `模型: ${state.effectiveModel}`,
      `模型来源: ${state.source}`,
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

function modelServiceFrom(ctx: CommandContext): CommandModelService {
  return ctx.modelService ?? new ModelService();
}

function formatProjectList(projects: ProjectListItem[], activeAlias: string): string {
  return [
    "项目列表:",
    ...projects.map(
      (project) =>
        `${project.active ? "*" : " "} ${project.alias} - ${project.cwd}${project.ready ? "" : " (未初始化)"}`,
    ),
    `当前项目: ${activeAlias}`,
  ].join("\n");
}

async function hasProject(manager: CommandProjectManager, alias: string): Promise<boolean> {
  return (await manager.listProjects()).some((project) => project.alias === alias);
}

async function unknownProject(alias: string, manager: CommandProjectManager): Promise<CommandResult> {
  return unknownProjectFromProjects(alias, await manager.listProjects());
}

function unknownProjectFromProjects(alias: string, projects: ProjectListItem[]): CommandResult {
  return {
    handled: true,
    reply: `未知项目: ${alias}\n可用项目: ${projects.map((project) => project.alias).join(", ")}`,
  };
}

async function parseOptionalProjectAlias(manager: CommandProjectManager, args: string): Promise<string | undefined | Error> {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  if (await hasProject(manager, trimmed)) return trimmed;
  return new Error(trimmed);
}

async function splitProjectArg(
  manager: CommandProjectManager,
  args: string,
): Promise<{ alias?: string; rest: string; first?: string; afterFirst: string }> {
  const trimmedStart = args.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmedStart);
  if (!match) return { rest: "", afterFirst: "" };
  const [, first, afterFirst] = match;
  if (await hasProject(manager, first)) {
    return { alias: first, rest: afterFirst, first, afterFirst };
  }
  return { rest: trimmedStart, first, afterFirst };
}

async function splitProjectPositionArg(
  manager: CommandProjectManager,
  args: string,
): Promise<{ alias?: string; rest: string; unknownAlias?: string }> {
  const trimmedStart = args.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmedStart);
  if (!match) return { rest: "" };
  const [, first, afterFirst] = match;
  if (await hasProject(manager, first)) {
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

async function parseProjectModeArg(
  manager: CommandProjectManager,
  args: string,
): Promise<{ alias?: string; modeArg: string; unknownAlias?: string }> {
  const parsed = splitFirstArg(args);
  if (!parsed.first) return { modeArg: "" };

  const afterFirst = parsed.afterFirst.trim();
  if (!afterFirst && MODES.includes(parsed.first as AgentMode)) {
    return { modeArg: parsed.first };
  }
  if (await hasProject(manager, parsed.first)) {
    return { alias: parsed.first, modeArg: afterFirst };
  }
  if (afterFirst) {
    return { modeArg: afterFirst, unknownAlias: parsed.first };
  }
  return { modeArg: parsed.rest.trim() };
}

async function parseProjectHistoryArg(
  manager: CommandProjectManager,
  args: string,
): Promise<{ alias?: string; limitText: string; unknownAlias?: string }> {
  const parsed = splitFirstArg(args);
  if (!parsed.first) return { limitText: "" };

  const afterFirst = parsed.afterFirst.trim();
  if (!afterFirst && isPositiveIntegerText(parsed.first)) {
    return { limitText: parsed.first };
  }
  if (await hasProject(manager, parsed.first)) {
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
    const projects = await manager.listProjects();
    return {
      handled: true,
      reply: [
        `当前项目: ${manager.activeProjectAlias}`,
        `当前工作目录: ${active.cwd}`,
        formatProjectList(projects, manager.activeProjectAlias),
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

  for (const project of await manager.listProjects()) {
    let projectCwd: string;
    try {
      projectCwd = await realpath(normalizeCommandPath(project.cwd));
    } catch {
      continue;
    }
    if (projectCwd === resolvedInput) {
      if (!project.ready) {
        return { handled: true, reply: formatProjectInitReply(project.alias) };
      }
      await manager.setActiveProject(project.alias);
      return { handled: true, reply: `当前项目已切换为: ${project.alias}\n工作目录: ${project.cwd}` };
    }
  }
  return { handled: true, reply: `未配置的项目目录: ${resolvedInput}\n/cwd 只能切换到已配置项目的 cwd。` };
}

export function formatProjectInitReply(alias: string): string {
  return `项目 ${alias} 还不是 Git 仓库。发送 /project ${alias} --init 初始化并切换。`;
}

async function handleProjectModel(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const parsed = await splitProjectPositionArg(manager, args);
  if (parsed.unknownAlias) return unknownProject(parsed.unknownAlias, manager);
  const alias = parsed.alias;
  const modelArg = alias ? parsed.rest : args;
  if (!modelArg.trim()) {
    const session = await manager.session(alias);
    const state = await modelServiceFrom(ctx).describeSession(session);
    return {
      handled: true,
      reply: `当前项目: ${alias ?? manager.activeProjectAlias}\n${formatCurrentModelState(state)}\n用法: /model [project] <name>`,
    };
  }
  const session = await manager.setModel(alias, modelArg);
  return { handled: true, reply: `项目 ${session.projectAlias} 模型已切换为: ${session.model ?? "Codex 默认"}` };
}

async function handleProjectMode(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const parsed = await parseProjectModeArg(manager, args);
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
  const modelService = modelServiceFrom(ctx);
  const alias = args.trim();
  if (alias) {
    if (!(await hasProject(manager, alias))) return unknownProject(alias, manager);
    const session = await manager.session(alias);
    const state = await modelService.describeSession(session);
    return { handled: true, reply: formatProjectSessionStatus(ctx.boundUserId, session, state) };
  }
  const lines = ["项目状态", `用户: ${ctx.boundUserId}`, `当前项目: ${manager.activeProjectAlias}`];
  for (const project of await manager.listProjects()) {
    const session = await manager.session(project.alias);
    const state = await modelService.describeSession(session);
    lines.push(
      `${project.active ? "*" : " "} ${project.alias} | ${session.state} | ${session.mode} | 模型: ${state.effectiveModel} | 模型来源: ${state.source} | ${session.cwd}`,
    );
  }
  return { handled: true, reply: lines.join("\n") };
}

async function handleProjectHistory(manager: CommandProjectManager, args: string): Promise<CommandResult> {
  const parsed = await parseProjectHistoryArg(manager, args);
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

function formatProjectSessionStatus(boundUserId: string, session: ProjectSession, state: ModelState): string {
  return [
    "项目会话状态",
    `项目: ${session.projectAlias}`,
    `用户: ${boundUserId}`,
    `状态: ${session.state}`,
    `工作目录: ${session.cwd}`,
    `模式: ${session.mode}`,
    `模型: ${state.effectiveModel}`,
    `模型来源: ${state.source}`,
    `Codex session: ${session.codexSessionId ?? "无"}`,
    `历史条数: ${session.history.length}`,
  ].join("\n");
}

function formatCurrentModelState(state: ModelState): string {
  return [`当前模型: ${state.effectiveModel}`, `模型来源: ${state.source}`].join("\n");
}

function formatModelCatalog(catalog: ModelCatalog): string {
  if (catalog.models.length === 0) {
    return "Codex 模型目录:\n（未找到可用模型）";
  }
  return ["Codex 模型目录:", ...catalog.models.map((model) => formatModelCatalogEntry(model))].join("\n");
}

function formatModelCatalogEntry(model: ModelCatalog["models"][number]): string {
  const display = model.displayName ? ` (${model.displayName})` : "";
  const details = [
    model.defaultReasoningLevel ? `reasoning: ${model.defaultReasoningLevel}` : undefined,
    model.description,
  ].filter((item): item is string => Boolean(item));
  return `- ${model.slug}${display}${details.length ? ` | ${details.join(" | ")}` : ""}`;
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
