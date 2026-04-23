import type { AgentMode } from "../backend/AgentBackend.js";
import type { AccountData } from "../config/accounts.js";
import type { ProjectDefinition, ProjectRegistry } from "../config/projects.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentService } from "./AgentService.js";
import { BusyProjectError, ProjectRuntime } from "./ProjectRuntime.js";
import type { TextSender } from "./types.js";

export interface ProjectRuntimeManagerOptions {
  account: Pick<AccountData, "boundUserId">;
  registry: ProjectRegistry;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots?: string[];
}

export interface ManagerRunPromptOptions {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
}

const VALID_MODES = new Set<AgentMode>(["readonly", "workspace", "yolo"]);

export class ProjectRuntimeManager {
  private readonly account: Pick<AccountData, "boundUserId">;
  private readonly registry: ProjectRegistry;
  private readonly sessionStore: ProjectSessionStore;
  private readonly sender: TextSender;
  private readonly agentService: AgentService;
  private readonly streamIntervalMs: number;
  private readonly extraWritableRoots: string[];
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private activeAlias: string;

  constructor(options: ProjectRuntimeManagerOptions) {
    this.account = options.account;
    this.registry = options.registry;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
    this.activeAlias = options.registry.defaultAlias;
  }

  setActiveProject(alias: string): ProjectDefinition {
    const project = this.registry.get(alias);
    this.activeAlias = project.alias;
    return project;
  }

  runtime(alias = this.activeAlias): ProjectRuntime {
    const project = this.registry.get(this.resolveAlias(alias));
    let runtime = this.runtimes.get(project.alias);
    if (!runtime) {
      runtime = new ProjectRuntime({
        userId: this.account.boundUserId,
        project,
        sessionStore: this.sessionStore,
        sender: this.sender,
        agentService: this.agentService,
        streamIntervalMs: this.streamIntervalMs,
        extraWritableRoots: this.extraWritableRoots,
      });
      this.runtimes.set(project.alias, runtime);
    }
    return runtime;
  }

  async runPrompt(options: ManagerRunPromptOptions): Promise<void> {
    const alias = this.resolveAlias(options.projectAlias);
    const runtime = this.runtime(alias);
    try {
      await runtime.runPrompt({
        prompt: options.prompt,
        toUserId: options.toUserId,
        contextToken: options.contextToken,
        active: alias === this.activeAlias,
      });
    } catch (error) {
      if (!(error instanceof BusyProjectError)) throw error;
      await this.sender.sendText(
        options.toUserId,
        options.contextToken,
        `[${error.projectAlias}] 正在处理上一轮任务。请使用 /interrupt ${error.projectAlias} 或 /replace ${error.projectAlias} <prompt>。`,
      );
    }
  }

  async replacePrompt(options: ManagerRunPromptOptions): Promise<void> {
    const alias = this.resolveAlias(options.projectAlias);
    const runtime = this.runtime(alias);
    await runtime.interrupt();
    await this.runPrompt({ ...options, projectAlias: alias });
  }

  async interrupt(alias?: string): Promise<void> {
    await this.runtime(alias).interrupt();
  }

  async interruptAll(): Promise<void> {
    await Promise.all(this.listProjects().map((project) => this.runtime(project.alias).interrupt()));
  }

  async clear(alias?: string): Promise<ProjectSession> {
    return this.runtime(alias).clear();
  }

  async session(alias?: string): Promise<ProjectSession> {
    return this.runtime(alias).session();
  }

  async setMode(alias: string, mode: AgentMode | string): Promise<ProjectSession> {
    if (!VALID_MODES.has(mode as AgentMode)) {
      throw new Error(`Invalid mode: ${mode}. Expected readonly, workspace, or yolo.`);
    }
    const session = await this.session(alias);
    session.mode = mode as AgentMode;
    await this.sessionStore.save(session);
    return session;
  }

  async setModel(alias: string, model: string | undefined): Promise<ProjectSession> {
    const session = await this.session(alias);
    session.model = model || undefined;
    await this.sessionStore.save(session);
    return session;
  }

  listProjects(): ProjectDefinition[] {
    return this.registry.list();
  }

  private resolveAlias(alias?: string): string {
    return this.registry.get(alias ?? this.activeAlias).alias;
  }
}
