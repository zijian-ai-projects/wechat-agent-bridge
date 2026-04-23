import { randomUUID } from "node:crypto";

import { extractSessionId } from "../backend/codexEvents.js";
import type { ProjectDefinition } from "../config/projects.js";
import { logger } from "../logging/logger.js";
import { StreamBuffer } from "../runtime/streamBuffer.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentService } from "./AgentService.js";
import type { TextSender } from "./types.js";

export class BusyProjectError extends Error {
  constructor(readonly projectAlias: string) {
    super(`Project is busy: ${projectAlias}`);
    this.name = "BusyProjectError";
  }
}

export interface ProjectRuntimeOptions {
  userId: string;
  project: ProjectDefinition;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots?: string[];
}

export interface ProjectRunPromptOptions {
  prompt: string;
  toUserId: string;
  contextToken: string;
  active: boolean;
}

const LIFECYCLE_EVENT_TYPES = new Set(["turn.started", "turn.completed", "turn.failed"]);

export class ProjectRuntime {
  readonly executionKey: string;

  private readonly userId: string;
  private readonly project: ProjectDefinition;
  private readonly sessionStore: ProjectSessionStore;
  private readonly sender: TextSender;
  private readonly agentService: AgentService;
  private readonly streamIntervalMs: number;
  private readonly extraWritableRoots: string[];
  private sessionPromise?: Promise<ProjectSession>;

  constructor(options: ProjectRuntimeOptions) {
    this.userId = options.userId;
    this.project = options.project;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
    this.executionKey = `${options.userId}:${options.project.alias}`;
  }

  session(): Promise<ProjectSession> {
    this.sessionPromise ??= this.sessionStore.load(this.userId, this.project, { resetStaleProcessing: true });
    return this.sessionPromise;
  }

  async runPrompt(options: ProjectRunPromptOptions): Promise<void> {
    const session = await this.session();
    if (session.state === "processing") throw new BusyProjectError(this.project.alias);

    const turnId = randomUUID();
    session.state = "processing";
    session.activeTurnId = turnId;
    this.sessionStore.addHistory(session, "user", options.prompt);
    await this.sessionStore.save(session);

    const prefix = `[${this.project.alias}] `;
    const stream = new StreamBuffer({
      intervalMs: this.streamIntervalMs,
      send: (chunk) => this.sender.sendText(options.toUserId, options.contextToken, chunk),
    });

    try {
      const result = await this.agentService.runTurn(
        {
          userId: this.userId,
          executionKey: this.executionKey,
          prompt: options.prompt,
          cwd: session.cwd,
          mode: session.mode,
          model: session.model,
          codexSessionId: session.codexSessionId,
          extraWritableRoots: this.extraWritableRoots,
        },
        {
          onEvent: async (event: unknown, formatted?: string) => {
            if (session.activeTurnId !== turnId) return;
            const id = extractSessionId(event as never);
            if (id) {
              session.codexSessionId = id;
              session.codexThreadId = id;
            }
            if (!formatted) return;
            if (options.active) {
              await stream.append(formatted);
              return;
            }
            if (isLifecycleEvent(event)) await stream.append(`${prefix}${formatted}`);
          },
        },
      );

      await stream.flush(true);
      if (session.activeTurnId !== turnId) return;
      if (result.clearedStaleSession) {
        session.codexSessionId = undefined;
        session.codexThreadId = undefined;
      }
      if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
      if (result.codexThreadId) session.codexThreadId = result.codexThreadId;

      if (result.interrupted) return;
      if (result.text) {
        this.sessionStore.addHistory(session, "assistant", result.text);
        if (!options.active) await this.sender.sendText(options.toUserId, options.contextToken, `${prefix}最终结果:\n${result.text}`);
        return;
      }
      await this.sender.sendText(options.toUserId, options.contextToken, `${options.active ? "" : prefix}Codex 本轮无文本返回。`);
    } catch (error) {
      if (session.activeTurnId !== turnId) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Project Codex turn failed", { projectAlias: this.project.alias, error: message });
      await this.sender.sendText(options.toUserId, options.contextToken, `${options.active ? "" : prefix}Codex 处理失败: ${message}`);
    } finally {
      if (session.activeTurnId === turnId) {
        session.state = "idle";
        session.activeTurnId = undefined;
        await this.sessionStore.save(session);
      }
    }
  }

  async interrupt(): Promise<void> {
    await this.agentService.interrupt(this.executionKey);
    const session = await this.session();
    session.state = "idle";
    session.activeTurnId = undefined;
    await this.sessionStore.save(session);
  }

  async clear(): Promise<ProjectSession> {
    await this.interrupt();
    const session = await this.sessionStore.clear(this.userId, this.project);
    this.sessionPromise = Promise.resolve(session);
    return session;
  }
}

function isLifecycleEvent(event: unknown): boolean {
  return Boolean(event && typeof event === "object" && LIFECYCLE_EVENT_TYPES.has(String((event as { type?: unknown }).type)));
}
