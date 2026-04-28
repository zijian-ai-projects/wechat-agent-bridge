import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "wechat-agent-bridge";

export function getDataDir(): string {
  return process.env.WECHAT_AGENT_BRIDGE_HOME || process.env.WECHAT_CODEX_BRIDGE_HOME || join(homedir(), ".wechat-agent-bridge");
}

export function getAccountsDir(): string {
  return join(getDataDir(), "accounts");
}

export function getSessionsDir(): string {
  return join(getDataDir(), "sessions");
}

export function getConfigPath(): string {
  return join(getDataDir(), "config.json");
}

export function getRuntimeStatePath(): string {
  return join(getDataDir(), "runtime-state.json");
}

export function getSyncBufferPath(): string {
  return join(getDataDir(), "sync-buffer.txt");
}

export function getPidPath(): string {
  return join(getDataDir(), `${APP_NAME}.pid`);
}

export function getAttachSocketPath(options: { platform?: NodeJS.Platform; dataDir?: string } = {}): string {
  const platform = options.platform ?? process.platform;
  const dataDir = options.dataDir ?? getDataDir();
  if (platform === "win32") {
    const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\${APP_NAME}-${hash}`;
  }
  return join(dataDir, "bridge.sock");
}

export function getDaemonLogPath(): string {
  return join(getDataDir(), "logs", "daemon.log");
}
