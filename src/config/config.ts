import { realpathSync } from "node:fs";

import { getConfigPath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface BridgeConfig {
  defaultCwd: string;
  allowlistRoots: string[];
  streamIntervalMs: number;
}

export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<Partial<BridgeConfig>>(getConfigPath(), {});
  return {
    defaultCwd: config.defaultCwd ?? cwd,
    allowlistRoots: config.allowlistRoots?.length ? config.allowlistRoots : [config.defaultCwd ?? cwd],
    streamIntervalMs: config.streamIntervalMs ?? 30_000,
  };
}

export function saveConfig(config: BridgeConfig): void {
  saveSecureJson(getConfigPath(), config);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
