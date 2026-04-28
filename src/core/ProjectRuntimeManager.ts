import type { AgentMode } from "../backend/AgentBackend.js";
import type { AccountData } from "../config/accounts.js";
import type { DiscoveredProject, ProjectDefinition } from "../config/projects.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentService } from "./AgentService.js";
import { NullEventBus, nowIso, type BridgeEventBus, type BridgePromptSource } from "./EventBus.js";
import { ModelService } from "./ModelService.js";
import { BusyProjectError, ProjectRuntime } from "./ProjectRuntime.js";
import type { TextSender } from "./types.js";

export interface ProjectCatalogPort {
  list(): Promise<DiscoveredProject[]>;
  get(alias: string): Promise<DiscoveredProject | undefined>;
  resolveInitialProject(defaultProject: string, lastProject?: string): Promise<DiscoveredProject>;
  init(alias: string): Promise<DiscoveredProject>;
}

export interface ProjectRuntimeManagerOptions {
  account: Pick<AccountData, "boundUserId">;
  catalog: ProjectCatalogPort;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots?: string[];
  initialProjectAlias: string;
  defaultProjectAlias: string;
  rememberActiveProject?: (alias: string) => Promise<void> | void;
  eventBus?: BridgeEventBus;
  modelService?: Pick<ModelService, "describeSession">;
}

export interface ManagerRunPromptOptions {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
  source?: BridgePromptSource;
  onAccepted?: (projectAlias: string) => void;
}

export interface ProjectListEntry extends DiscoveredProject {
  active: boolean;
}

const VALID_MODES = new Set<AgentMode>(["readonly", "workspace", "yolo"]);

export class ProjectInitRequiredError extends Error {
  constructor(readonly projectAlias: string) {
    super(`Project requires git init: ${projectAlias}`);
    this.name = "ProjectInitRequiredError";
  }
}

export class ProjectRuntimeManager {
  private readonly account: Pick<AccountData, "boundUserId">;
  private readonly catalog: ProjectCatalogPort;
  private readonly sessionStore: ProjectSessionStore;
  private readonly sender: TextSender;
  private readonly agentService: AgentService;
  private readonly streamIntervalMs: number;
  private readonly extraWritableRoots: string[];
  private readonly defaultProjectAlias: string;
  private readonly rememberActiveProject?: (alias: string) => Promise<void> | void;
  private readonly eventBus: BridgeEventBus;
  private readonly modelService: Pick<ModelService, "describeSession">;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private activeAlias: string;

  constructor(options: ProjectRuntimeManagerOptions) {
    this.account = options.account;
    this.catalog = options.catalog;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
    this.activeAlias = options.initialProjectAlias;
    this.defaultProjectAlias = options.defaultProjectAlias;
    this.rememberActiveProject = options.rememberActiveProject;
    this.eventBus = options.eventBus ?? new NullEventBus();
    this.modelService = options.modelService ?? new ModelService();
  }

  get activeProjectAlias(): string {
    return this.activeAlias;
  }

  async initializeProject(alias: string): Promise<DiscoveredProject> {
    const project = await this.catalog.init(alias);
    this.activeAlias = project.alias;
    await this.rememberActiveProject?.(project.alias);
    return project;
  }

  async setActiveProject(alias: string): Promise<DiscoveredProject> {
    const project = await this.requireProject(alias);
    this.activeAlias = project.alias;
    await this.rememberActiveProject?.(project.alias);
    return project;
  }

  async runtime(alias?: string): Promise<ProjectRuntime> {
    const project = await this.requireRunnableProject(alias);
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
        eventBus: this.eventBus,
        modelService: this.modelService,
      });
      this.runtimes.set(project.alias, runtime);
    }
    return runtime;
  }

  async runPrompt(options: ManagerRunPromptOptions): Promise<void> {
    const alias = await this.resolveAlias(options.projectAlias);
    const runtime = await this.runtime(alias);
    try {
      await runtime.runPrompt({
        prompt: options.prompt,
        toUserId: options.toUserId,
        contextToken: options.contextToken,
        isActive: () => alias === this.activeAlias,
        source: options.source,
        onAccepted: () => {
          void this.eventBus
            .publish({
              type: "user_message",
              source: options.source ?? "wechat",
              project: alias,
              text: options.prompt,
              timestamp: nowIso(),
            })
            .catch(() => undefined);
          options.onAccepted?.(alias);
        },
      });
    } catch (error) {
      if (!(error instanceof BusyProjectError)) throw error;
      if (options.source === "attach") throw error;
      await this.sender.sendText(
        options.toUserId,
        options.contextToken,
        `[${error.projectAlias}] 正在处理上一轮任务。请使用 /interrupt ${error.projectAlias} 或 /replace ${error.projectAlias} <prompt>。`,
      );
    }
  }

  async replacePrompt(options: ManagerRunPromptOptions): Promise<void> {
    const alias = await this.resolveAlias(options.projectAlias);
    const runtime = await this.runtime(alias);
    await runtime.interrupt();
    await this.runPrompt({ ...options, projectAlias: alias });
  }

  async interrupt(alias?: string): Promise<void> {
    const runtime = await this.runtime(alias);
    await runtime.interrupt();
  }

  async interruptAll(): Promise<void> {
    const projects = await this.listProjects();
    await Promise.all(
      projects
        .filter((project) => project.ready)
        .map(async (project) => {
          const runtime = await this.runtime(project.alias);
          await runtime.interrupt();
        }),
    );
  }

  async clear(alias?: string): Promise<ProjectSession> {
    const runtime = await this.runtime(alias);
    return runtime.clear();
  }

  async session(alias?: string): Promise<ProjectSession> {
    const runtime = await this.runtime(alias);
    return runtime.session();
  }

  async setMode(alias: string | undefined, mode: AgentMode | string): Promise<ProjectSession> {
    if (!VALID_MODES.has(mode as AgentMode)) {
      throw new Error(`Invalid mode: ${mode}. Expected readonly, workspace, or yolo.`);
    }
    const session = await this.session(alias);
    session.mode = mode as AgentMode;
    await this.sessionStore.save(session);
    return session;
  }

  async setModel(alias: string | undefined, model: string | undefined): Promise<ProjectSession> {
    const session = await this.session(alias);
    session.model = model?.trim() || undefined;
    await this.sessionStore.save(session);
    return session;
  }

  async listProjects(): Promise<ProjectListEntry[]> {
    const projects = await this.catalog.list();
    return projects.map((project) => ({ ...project, active: project.alias === this.activeAlias }));
  }

  private async resolveAlias(alias?: string): Promise<string> {
    return (await this.requireProject(alias)).alias;
  }

  private async requireProject(alias?: string): Promise<DiscoveredProject> {
    const requestedAlias = alias ?? this.activeAlias;
    const project = await this.catalog.get(requestedAlias);
    if (project) {
      return project;
    }
    if (alias) {
      throw new Error(`Unknown project: ${alias}`);
    }
    const fallback = await this.catalog.resolveInitialProject(this.defaultProjectAlias);
    this.activeAlias = fallback.alias;
    await this.rememberActiveProject?.(fallback.alias);
    return fallback;
  }

  private async requireRunnableProject(alias?: string): Promise<DiscoveredProject> {
    const project = await this.requireProject(alias);
    if (!project.ready) {
      throw new ProjectInitRequiredError(project.alias);
    }
    return project;
  }
}
