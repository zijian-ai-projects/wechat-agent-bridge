import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import { getSyncBufferPath } from "../config/paths.js";

export function loadSyncBuffer(): string {
  try {
    return readFileSync(getSyncBufferPath(), "utf8").trim();
  } catch {
    return "";
  }
}

export function saveSyncBuffer(value: string): void {
  const path = getSyncBufferPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
