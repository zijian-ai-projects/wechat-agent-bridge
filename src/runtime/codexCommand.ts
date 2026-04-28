import { spawnSync } from "node:child_process";

const CODEX_BIN_ENV = "WECHAT_AGENT_BRIDGE_CODEX_BIN";

export interface CodexCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface CodexSpawnSyncResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

export type CodexSpawnSync = (
  command: string,
  args: string[],
  options: { encoding: "utf8" },
) => CodexSpawnSyncResult;

export interface CodexCommandSyncResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function codexCommandCandidates(options: CodexCommandOptions = {}): string[] {
  const env = options.env ?? process.env;
  const override = env[CODEX_BIN_ENV]?.trim();
  if (override) return [override];
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return ["codex.cmd", "codex.exe", "codex.bat", "codex"];
  return ["codex"];
}

export function defaultCodexCommand(options: CodexCommandOptions = {}): string {
  return codexCommandCandidates(options)[0] ?? "codex";
}

export function runCodexCommandSync(
  args: string[],
  options: {
    candidates?: string[];
    spawnSync?: CodexSpawnSync;
  } = {},
): CodexCommandSyncResult {
  const candidates = options.candidates ?? codexCommandCandidates();
  const run = options.spawnSync ?? spawnSync;
  let lastResult: CodexCommandSyncResult | undefined;

  for (const command of candidates) {
    const result = normalizeResult(command, run(command, args, { encoding: "utf8" }));
    lastResult = result;
    if (!isEnoent(result)) return result;
  }

  return lastResult ?? {
    command: defaultCodexCommand(),
    status: null,
    stdout: "",
    stderr: "codex command not found",
  };
}

function normalizeResult(command: string, result: CodexSpawnSyncResult): CodexCommandSyncResult {
  return {
    command,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

function isEnoent(result: CodexCommandSyncResult): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error?.code === "ENOENT";
}
