import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type CodexLoginState = "chatgpt" | "api-key" | "logged-out" | "unknown";

export interface CodexLoginStatus {
  state: CodexLoginState;
  message: string;
}

export interface CodexLoginStatusProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function parseCodexLoginStatus(result: CodexLoginStatusProcessResult): CodexLoginStatus {
  const message = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const normalized = message.toLowerCase();

  if (result.status === 0 && normalized.includes("chatgpt")) {
    return { state: "chatgpt", message: firstLine(message) };
  }
  if (result.status === 0 && normalized.includes("api key")) {
    return { state: "api-key", message: firstLine(message) };
  }
  if (result.status !== 0 || normalized.includes("not logged in") || normalized.includes("logged out")) {
    return { state: "logged-out", message: firstLine(message) || "Not logged in" };
  }
  return { state: "unknown", message: firstLine(message) || "Unable to determine Codex login status" };
}

export function checkCodexLoginStatus(): CodexLoginStatus {
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  return parseCodexLoginStatus({
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  });
}

export function formatCodexLoginGuidance(status: CodexLoginStatus): string {
  if (status.state === "chatgpt") return `Codex 已使用 ChatGPT 登录: ${status.message}`;
  if (status.state === "api-key") return `Codex 已使用 API key 登录: ${status.message}`;
  return [
    `Codex 尚未登录: ${status.message}`,
    "请先在当前系统用户的终端运行 codex login。",
    "如果浏览器回调不方便，请运行 codex login --device-auth。",
    "wechat-agent-bridge 默认复用当前用户的 Codex 登录态，不要求配置 OPENAI_API_KEY。",
  ].join("\n");
}

export function assertCodexLoggedIn(status = checkCodexLoginStatus()): CodexLoginStatus {
  if (status.state === "chatgpt" || status.state === "api-key") return status;
  throw new Error(formatCodexLoginGuidance(status));
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export function codexAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), "auth.json");
}

export function checkCodexFileAuthPermissions(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = codexAuthJsonPath(env);
  if (!existsSync(file)) return undefined;
  if (process.platform === "win32") return file;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Codex auth.json 权限过宽: ${file}，请执行 chmod 600 ${file}`);
  }
  return file;
}

function firstLine(message: string): string {
  return message.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
