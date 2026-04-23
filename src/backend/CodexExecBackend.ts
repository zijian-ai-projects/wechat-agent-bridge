import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { AgentBackend, AgentMode, AgentTurnRequest, AgentTurnResult } from "./AgentBackend.js";
import { extractSessionId, extractText, parseJsonLine, type CodexEvent } from "./codexEvents.js";

export interface BuildCodexArgsInput {
  prompt: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  codexSessionId?: string;
  extraWritableRoots?: string[];
}

function modeFlags(mode: AgentMode): string[] {
  switch (mode) {
    case "readonly":
      return ["--sandbox", "read-only", "--ask-for-approval", "never"];
    case "workspace":
      return ["--sandbox", "workspace-write", "--ask-for-approval", "never"];
    case "yolo":
      return ["--dangerously-bypass-approvals-and-sandbox"];
  }
}

export function buildCodexExecArgs(input: BuildCodexArgsInput): string[] {
  const model = input.model ? ["--model", input.model] : [];
  const addDirFlags = input.mode === "workspace"
    ? (input.extraWritableRoots ?? [])
      .filter((root) => root !== input.cwd)
      .flatMap((root) => ["--add-dir", root])
    : [];
  const topLevelFlags = [...modeFlags(input.mode), "--cd", input.cwd, ...addDirFlags];
  if (input.codexSessionId) {
    return [
      ...topLevelFlags,
      "exec",
      "resume",
      "--json",
      ...model,
      input.codexSessionId,
      input.prompt,
    ];
  }

  return [...topLevelFlags, "exec", "--json", ...model, input.prompt];
}

export function formatCodexEventForWechat(raw: unknown): string | undefined {
  const event = raw as CodexEvent;
  switch (event.type) {
    case "thread.started": {
      const id = extractSessionId(event);
      return id ? `Codex 线程已开始: ${id}` : "Codex 线程已开始";
    }
    case "turn.started":
      return "Codex 开始处理";
    case "turn.completed":
      return "Codex 本轮完成";
    case "turn.failed":
      return `Codex 处理失败: ${errorMessage(event.error)}`;
    case "item.started":
      return formatItem(event.item, "开始");
    case "item.completed":
      return formatItem(event.item, "完成") ?? extractText(event);
    case "error":
      if (isTransientCodexError(event.error ?? event.message)) return undefined;
      return `Codex 错误: ${errorMessage(event.error ?? event.message)}`;
    default:
      return extractText(event);
  }
}

function isTransientCodexError(error: unknown): boolean {
  const message = errorMessage(error);
  return /^Reconnecting\.\.\./i.test(message) || /timeout waiting for child process to exit/i.test(message);
}

export interface InterruptibleChildProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close" | "exit", listener: () => void): unknown;
}

export async function interruptChildProcess(
  child: InterruptibleChildProcess,
  timeoutMs: number,
): Promise<void> {
  child.kill("SIGINT");

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    timer.unref();
    child.once("close", finish);
    child.once("exit", finish);
  });
}

function formatItem(item: Record<string, unknown> | undefined, verb: string): string | undefined {
  if (!item) return undefined;
  const type = String(item.type ?? item.kind ?? "");
  if (["message", "assistant_message", "agent_message"].includes(type)) {
    return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : undefined;
  }
  if (type.includes("reasoning") || type === "plan") {
    const summary = item.summary ?? item.text ?? item.content;
    return summary ? `思路摘要: ${String(summary)}` : undefined;
  }
  if (type.includes("command")) {
    const command = String(item.command ?? item.cmd ?? "命令");
    const exitCode = item.exit_code ?? item.exitCode;
    return `命令${verb}: ${command}${exitCode !== undefined ? ` (exit ${String(exitCode)})` : ""}`;
  }
  if (type.includes("file") || item.path) {
    const action = String(item.action ?? verb);
    const file = String(item.path ?? item.file ?? "文件");
    return `文件变更: ${action} ${file}`;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (!error) return "未知错误";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}

export class CodexExecBackend implements AgentBackend {
  private readonly children = new Map<string, ChildProcess>();
  private readonly interruptTimeoutMs = 2_000;

  constructor(private readonly codexBin = "codex") {}

  startTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    return this.runTurn({ ...request, codexSessionId: undefined }, callbacks);
  }

  resumeTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    return this.runTurn(request, callbacks);
  }

  async interrupt(executionKey: string): Promise<void> {
    const child = this.children.get(executionKey);
    if (!child) return;
    await interruptChildProcess(child, this.interruptTimeoutMs);
    this.children.delete(executionKey);
  }

  formatEventForWechat(event: unknown): string | undefined {
    return formatCodexEventForWechat(event);
  }

  private runTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    const args = buildCodexExecArgs(request);
    const executionKey = request.executionKey ?? request.userId;
    const child = spawn(this.codexBin, args, {
      cwd: request.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(executionKey, child);

    let text = "";
    let codexSessionId = request.codexSessionId;
    let codexThreadId: string | undefined;
    let interrupted = false;
    let stderr = "";

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const event = parseJsonLine(line, { source: "stdout" });
      if (!event) return;
      const id = extractSessionId(event);
      if (id) {
        codexSessionId = id;
        codexThreadId = id;
      }
      const eventText = extractText(event);
      if (eventText && isAssistantTextEvent(event)) {
        text += text ? `\n${eventText}` : eventText;
      }
      const formatted = this.formatEventForWechat(event);
      void callbacks.onEvent?.(event, formatted);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      stderr += error.message;
    });

    child.on("exit", (_code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGKILL") interrupted = true;
    });

    return new Promise((resolve, reject) => {
      child.on("close", (code, signal) => {
        this.children.delete(executionKey);
        if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGKILL") interrupted = true;
        if (code && !interrupted) {
          reject(new Error(`codex exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        resolve({ text, codexSessionId, codexThreadId, interrupted });
      });
    });
  }
}

function isAssistantTextEvent(event: CodexEvent): boolean {
  if (event.type === "turn.completed" || event.type === "item.completed") {
    const itemType = String(event.item?.type ?? "");
    return ["message", "assistant_message", "agent_message"].includes(itemType) || Boolean(extractText(event));
  }
  return false;
}
