import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../config/paths.js";
import { redactSecrets } from "./redact.js";

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

export interface LoggerOptions {
  logDir?: string;
  maxLogFiles?: number;
}

function logFileName(date = new Date()): string {
  return `bridge-${date.toISOString().slice(0, 10)}.log`;
}

function cleanupOldLogs(logDir: string, maxLogFiles: number): void {
  try {
    const files = readdirSync(logDir)
      .filter((file) => file.startsWith("bridge-") && file.endsWith(".log"))
      .sort();
    while (files.length > maxLogFiles) {
      const file = files.shift();
      if (file) unlinkSync(join(logDir, file));
    }
  } catch {
    // Logging must never crash the daemon.
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const logDir = options.logDir ?? join(getDataDir(), "logs");
  const maxLogFiles = options.maxLogFiles ?? 14;

  function write(level: string, message: string, data?: unknown): void {
    mkdirSync(logDir, { recursive: true });
    cleanupOldLogs(logDir, maxLogFiles);
    const parts = [new Date().toISOString(), level, message];
    if (data !== undefined) parts.push(redactSecrets(data));
    appendFileSync(join(logDir, logFileName()), `${parts.join(" ")}\n`, "utf8");
  }

  return {
    info: (message, data) => write("INFO", message, data),
    warn: (message, data) => write("WARN", message, data),
    error: (message, data) => write("ERROR", message, data),
    debug: (message, data) => {
      if (process.env.WECHAT_CODEX_BRIDGE_DEBUG === "1") write("DEBUG", message, data);
    },
  };
}

export const logger = createLogger();
