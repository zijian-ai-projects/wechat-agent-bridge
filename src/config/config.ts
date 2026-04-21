import { realpathSync } from "node:fs";

import { getConfigPath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface BridgeConfig {
  defaultCwd: string;
  allowlistRoots: string[];
  extraWritableRoots: string[];
  streamIntervalMs: number;
}

export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<Partial<BridgeConfig>>(getConfigPath(), {});
  return {
    defaultCwd: config.defaultCwd ?? cwd,
    allowlistRoots: config.allowlistRoots?.length ? config.allowlistRoots : [config.defaultCwd ?? cwd],
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
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
