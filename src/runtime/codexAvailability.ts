import { spawnSync } from "node:child_process";

export interface CodexCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export function checkCodexInstalled(): CodexCheckResult {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, version: (result.stdout || result.stderr).trim() };
  }
  return {
    ok: false,
    error: result.error?.message || result.stderr?.trim() || "codex command not found",
  };
}
