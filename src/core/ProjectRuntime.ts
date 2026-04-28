import { randomUUID } from "node:crypto";

import { extractSessionId } from "../backend/codexEvents.js";
import type { ProjectDefinition } from "../config/projects.js";
import { logger } from "../logging/logger.js";
import { StreamBuffer } from "../runtime/streamBuffer.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentService } from "./AgentService.js";
import { NullEventBus, nowIso, type BridgeEventBus, type BridgePromptSource } from "./EventBus.js";
import { ModelService, type ModelState } from "./ModelService.js";
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
  eventBus?: BridgeEventBus;
  modelService?: Pick<ModelService, "describeSession">;
}

export interface ProjectRunPromptOptions {
  prompt: string;
  toUserId: string;
  contextToken: string;
  isActive: () => boolean;
  source?: BridgePromptSource;
  onAccepted?: () => void;
}

const LIFECYCLE_EVENT_TYPES = new Set(["turn.started", "turn.completed", "turn.failed"]);
const FALLBACK_MODEL_STATE: ModelState = { effectiveModel: "Codex CLI default", source: "unresolved" };

export class ProjectRuntime {
  readonly executionKey: string;

  private readonly userId: string;
  private readonly project: ProjectDefinition;
  private readonly sessionStore: ProjectSessionStore;
  private readonly sender: TextSender;
  private readonly agentService: AgentService;
  private readonly streamIntervalMs: number;
  private readonly extraWritableRoots: string[];
  private readonly eventBus: BridgeEventBus;
  private readonly modelService: Pick<ModelService, "describeSession">;
  private sessionPromise?: Promise<ProjectSession>;
  private interruptPromise?: Promise<void>;

  constructor(options: ProjectRuntimeOptions) {
    this.userId = options.userId;
    this.project = options.project;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
    this.eventBus = options.eventBus ?? new NullEventBus();
    this.modelService = options.modelService ?? new ModelService();
    this.executionKey = `${options.userId}:${options.project.alias}`;
  }

  session(): Promise<ProjectSession> {
    this.sessionPromise ??= this.sessionStore.load(this.userId, this.project, { resetStaleProcessing: true });
    return this.sessionPromise;
  }

  async runPrompt(options: ProjectRunPromptOptions): Promise<void> {
    const session = await this.session();
    if (this.interruptPromise || session.state === "processing") throw new BusyProjectError(this.project.alias);

    const turnId = randomUUID();
    session.state = "processing";
    session.activeTurnId = turnId;
    this.sessionStore.addHistory(session, "user", options.prompt);
    await this.sessionStore.save(session);
    options.onAccepted?.();

    const prefix = `[${this.project.alias}] `;
    const stream = new StreamBuffer({
      intervalMs: this.streamIntervalMs,
      send: async (chunk) => {
        if (session.activeTurnId !== turnId) return;
        await this.sender.sendText(options.toUserId, options.contextToken, options.isActive() ? chunk : prefixLines(prefix, chunk));
      },
    });

    let rethrowAfterFailureEvent = false;
    try {
      const modelState = await this.describeModelState(session);
      this.publishEvent({
        type: "turn_started",
        source: options.source ?? "wechat",
        project: this.project.alias,
        model: modelState.effectiveModel,
        modelSource: modelState.source,
        mode: session.mode,
        timestamp: nowIso(),
      });

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
            this.publishEvent({
              type: "codex_event",
              project: this.project.alias,
              text: formatted,
              timestamp: nowIso(),
            });
            if (options.isActive()) {
              await stream.append(formatted);
              return;
            }
            if (isLifecycleEvent(event)) await stream.append(formatted);
          },
        },
      );

      if (session.activeTurnId !== turnId) return;
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
        if (!options.isActive()) {
          try {
            await this.sendWithDynamicPrefix(options, prefix, `最终结果:\n${result.text}`);
          } catch (error) {
            rethrowAfterFailureEvent = true;
            throw error;
          }
        }
        this.publishEvent({
          type: "turn_completed",
          project: this.project.alias,
          text: result.text,
          timestamp: nowIso(),
        });
        return;
      }
      try {
        await this.sendWithDynamicPrefix(options, prefix, "Codex 本轮无文本返回。");
      } catch (error) {
        rethrowAfterFailureEvent = true;
        throw error;
      }
      this.publishEvent({ type: "turn_completed", project: this.project.alias, timestamp: nowIso() });
    } catch (error) {
      if (session.activeTurnId !== turnId) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Project Codex turn failed", { projectAlias: this.project.alias, error: message });
      try {
        await this.sendWithDynamicPrefix(options, prefix, `Codex 处理失败: ${message}`);
      } catch (sendError) {
        logger.warn("Failed to send project failure message", {
          projectAlias: this.project.alias,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
      this.publishEvent({ type: "turn_failed", project: this.project.alias, message, timestamp: nowIso() });
      if (rethrowAfterFailureEvent) throw error;
    } finally {
      if (session.activeTurnId === turnId) {
        session.state = "idle";
        session.activeTurnId = undefined;
        await this.sessionStore.save(session);
        await this.publishState(session);
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.interruptPromise) {
      await this.interruptPromise;
      return;
    }

    const interruptPromise = (async () => {
      const session = await this.session();
      session.state = "idle";
      session.activeTurnId = undefined;
      await this.sessionStore.save(session);
      await this.publishState(session);
      await this.agentService.interrupt(this.executionKey);
    })();
    this.interruptPromise = interruptPromise;
    try {
      await interruptPromise;
    } finally {
      if (this.interruptPromise === interruptPromise) this.interruptPromise = undefined;
    }
  }

  async clear(): Promise<ProjectSession> {
    await this.interrupt();
    const session = await this.sessionStore.clear(this.userId, this.project);
    this.sessionPromise = Promise.resolve(session);
    return session;
  }

  private async sendWithDynamicPrefix(options: ProjectRunPromptOptions, prefix: string, text: string): Promise<void> {
    await this.sender.sendText(options.toUserId, options.contextToken, options.isActive() ? text : prefixLines(prefix, text));
  }

  private publishEvent(event: Parameters<BridgeEventBus["publish"]>[0]): void {
    void this.eventBus.publish(event).catch((error) => {
      logger.warn("Bridge event publication failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async describeModelState(session: Pick<ProjectSession, "model">): Promise<ModelState> {
    try {
      return await this.modelService.describeSession(session);
    } catch (error) {
      logger.warn("Unable to resolve model state for bridge event", {
        projectAlias: this.project.alias,
        error: error instanceof Error ? error.message : String(error),
      });
      return FALLBACK_MODEL_STATE;
    }
  }

  private async publishState(session: ProjectSession): Promise<void> {
    const modelState = await this.describeModelState(session);
    this.publishEvent({
      type: "state",
      project: this.project.alias,
      state: session.state,
      model: modelState.effectiveModel,
      modelSource: modelState.source,
      timestamp: nowIso(),
    });
  }
}

function isLifecycleEvent(event: unknown): boolean {
  return Boolean(event && typeof event === "object" && LIFECYCLE_EVENT_TYPES.has(String((event as { type?: unknown }).type)));
}

function prefixLines(prefix: string, text: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
