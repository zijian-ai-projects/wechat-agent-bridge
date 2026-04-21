import { join } from "node:path";

import { getSessionsDir } from "../config/paths.js";
import { loadSecureJson, saveSecureJson } from "../config/secureStore.js";
import { validateStorageId } from "../config/security.js";
import type { BridgeSession, SessionDefaults } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 100;

export class FileSessionStore {
  constructor(private readonly sessionsDir = getSessionsDir()) {}

  async load(userId: string, defaults: SessionDefaults): Promise<BridgeSession> {
    validateStorageId(userId, "userId");
    const session = loadSecureJson<BridgeSession | null>(this.pathFor(userId), null) ?? {
      userId,
      state: "idle",
      cwd: defaults.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: defaults.allowlistRoots,
      updatedAt: new Date().toISOString(),
    };

    session.userId = userId;
    session.cwd ||= defaults.cwd;
    session.mode ||= "readonly";
    session.history ||= [];
    session.allowlistRoots = defaults.allowlistRoots.length > 0 ? defaults.allowlistRoots : session.allowlistRoots;
    if (defaults.resetStaleProcessing && session.state !== "idle") {
      session.state = "idle";
    }
    return session;
  }

  async save(session: BridgeSession): Promise<void> {
    validateStorageId(session.userId, "userId");
    session.updatedAt = new Date().toISOString();
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
    saveSecureJson(this.pathFor(session.userId), session);
  }

  async clear(userId: string, defaults: SessionDefaults): Promise<BridgeSession> {
    const session: BridgeSession = {
      userId,
      state: "idle",
      cwd: defaults.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: defaults.allowlistRoots,
      updatedAt: new Date().toISOString(),
    };
    await this.save(session);
    return session;
  }

  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
  }

  formatHistory(session: BridgeSession, limit = 20): string {
    const entries = session.history.slice(-Math.max(1, Math.min(limit, DEFAULT_HISTORY_LIMIT)));
    if (entries.length === 0) return "暂无对话记录";
    return entries
      .map((entry) => {
        const role = entry.role === "user" ? "用户" : "Codex";
        return `[${new Date(entry.timestamp).toLocaleString("zh-CN")}] ${role}:\n${entry.content}`;
      })
      .join("\n\n");
  }

  private pathFor(userId: string): string {
    validateStorageId(userId, "userId");
    return join(this.sessionsDir, `${userId}.json`);
  }
}
