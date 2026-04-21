import { checkCodexInstalled } from "./codexAvailability.js";
import { assertCodexLoggedIn, checkCodexFileAuthPermissions, checkCodexLoginStatus, type CodexLoginStatus } from "../config/codexAuth.js";
import { assertCwdPreflight } from "../config/git.js";
import type { BridgeConfig } from "../config/config.js";
import type { CodexCheckResult } from "./codexAvailability.js";

export interface PreflightResult {
  codexVersion?: string;
  login: CodexLoginStatus;
  cwd: string;
}

export async function runPreflight(config: BridgeConfig): Promise<PreflightResult> {
  return runPreflightWithChecks(config, {
    checkCodexInstalled,
    checkCodexLoginStatus,
    checkCodexFileAuthPermissions,
  });
}

export async function runPreflightWithChecks(
  config: BridgeConfig,
  checks: {
    checkCodexInstalled: () => CodexCheckResult;
    checkCodexLoginStatus: () => CodexLoginStatus;
    checkCodexFileAuthPermissions: () => string | undefined;
  },
): Promise<PreflightResult> {
  const codex = checks.checkCodexInstalled();
  if (!codex.ok) {
    throw new Error(`未找到本机 codex CLI: ${codex.error}\n请先安装 Codex CLI。`);
  }

  const login = assertCodexLoggedIn(checks.checkCodexLoginStatus());
  checks.checkCodexFileAuthPermissions();
  const cwd = await assertCwdPreflight(config.defaultCwd, config.allowlistRoots);

  return { codexVersion: codex.version, login, cwd };
}
