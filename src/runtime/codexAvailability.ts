import { runCodexCommandSync, type CodexSpawnSync } from "./codexCommand.js";

export interface CodexCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
  command?: string;
}

export function checkCodexInstalled(options: { candidates?: string[]; spawnSync?: CodexSpawnSync } = {}): CodexCheckResult {
  const result = runCodexCommandSync(["--version"], options);
  if (result.status === 0) {
    return { ok: true, version: (result.stdout || result.stderr).trim(), command: result.command };
  }
  return {
    ok: false,
    error: result.error?.message || result.stderr?.trim() || "codex command not found",
    command: result.command,
  };
}
