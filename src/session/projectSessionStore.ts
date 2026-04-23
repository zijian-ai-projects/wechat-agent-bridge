import { join } from "node:path";

import { getSessionsDir } from "../config/paths.js";
import type { ProjectDefinition } from "../config/projects.js";
import { loadSecureJson, saveSecureJson } from "../config/secureStore.js";
import { validateStorageId } from "../config/security.js";
import type { ProjectSession, ProjectSessionDefaults } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 100;

export class ProjectSessionStore {
  constructor(private readonly sessionsDir = getSessionsDir()) {}

  async load(userId: string, project: ProjectDefinition, defaults: ProjectSessionDefaults = {}): Promise<ProjectSession> {
    validateStorageId(userId, "userId");
    validateStorageId(project.alias, "projectAlias");
    const session =
      loadSecureJson<ProjectSession | null>(this.pathFor(userId, project.alias), null) ??
      this.freshSession(userId, project);

    session.userId = userId;
    session.projectAlias = project.alias;
    session.cwd = project.cwd;
    session.allowlistRoots = [project.cwd];
    session.mode ||= "readonly";
    session.history ||= [];
    if (defaults.resetStaleProcessing && session.state !== "idle") {
      session.state = "idle";
      delete session.activeTurnId;
    }
    return session;
  }

  async save(session: ProjectSession): Promise<void> {
    validateStorageId(session.userId, "userId");
    validateStorageId(session.projectAlias, "projectAlias");
    session.updatedAt = new Date().toISOString();
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
    saveSecureJson(this.pathFor(session.userId, session.projectAlias), session);
  }

  async clear(userId: string, project: ProjectDefinition): Promise<ProjectSession> {
    const session = this.freshSession(userId, project);
    await this.save(session);
    return session;
  }

  addHistory(session: ProjectSession, role: "user" | "assistant", content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
  }

  formatHistory(session: ProjectSession, limit = 20): string {
    const entries = session.history.slice(-Math.max(1, Math.min(limit, DEFAULT_HISTORY_LIMIT)));
    if (entries.length === 0) return "暂无对话记录";
    return entries
      .map((entry) => {
        const role = entry.role === "user" ? "用户" : "Codex";
        return `[${new Date(entry.timestamp).toLocaleString("zh-CN")}] ${role}:\n${entry.content}`;
      })
      .join("\n\n");
  }

  private freshSession(userId: string, project: ProjectDefinition): ProjectSession {
    return {
      userId,
      projectAlias: project.alias,
      state: "idle",
      cwd: project.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: [project.cwd],
      updatedAt: new Date().toISOString(),
    };
  }

  private pathFor(userId: string, projectAlias: string): string {
    validateStorageId(userId, "userId");
    validateStorageId(projectAlias, "projectAlias");
    return join(this.sessionsDir, userId, `${projectAlias}.json`);
  }
}
