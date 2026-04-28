import { realpath } from "node:fs/promises";

import { CodexExecBackend } from "../backend/CodexExecBackend.js";
import type { AgentBackend } from "../backend/AgentBackend.js";
import { loadLatestAccount, type AccountData } from "../config/accounts.js";
import { loadConfig, type BridgeConfig } from "../config/config.js";
import { getAttachSocketPath } from "../config/paths.js";
import { ProjectCatalog, resolveProjectsRootConfig, type ProjectDefinition } from "../config/projects.js";
import { loadRuntimeState, saveRuntimeState, type BridgeRuntimeState } from "../config/runtimeState.js";
import { logger } from "../logging/logger.js";
import { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { BridgeSession, ProjectSession } from "../session/types.js";
import { WeChatApi } from "../wechat/api.js";
import { WeChatMonitor } from "../wechat/monitor.js";
import { createWechatSender, type WeChatSender } from "../wechat/sender.js";
import type { WeixinMessage } from "../wechat/types.js";
import { runPreflight } from "./preflight.js";
import { AgentService } from "../core/AgentService.js";
import { BridgeService } from "../core/BridgeService.js";
import { EventBus } from "../core/EventBus.js";
import { ModelService } from "../core/ModelService.js";
import { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import type { SessionStorePort } from "../core/types.js";
import { AttachServer } from "../ipc/AttachServer.js";
import { launchAttachTerminal } from "../ipc/attachTerminal.js";

export async function runBridge(backend?: AgentBackend): Promise<void> {
  const config = loadConfig();
  const preflight = await runPreflight(config);
  logger.info("Codex preflight passed", { loginState: preflight.login.state, cwd: preflight.cwd });
  const account = loadLatestAccount();
  if (!account) {
    throw new Error("未找到微信账号，请先运行 npm run setup");
  }
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sender = createWechatSender(api, account.accountId);
  const effectiveBackend = backend ?? new CodexExecBackend(preflight.codexCommand);
  const { bridgeService, projectManager, eventBus, modelService } = await buildProjectBridgeRuntime({
    account,
    config,
    sender,
    backend: effectiveBackend,
    codexBin: preflight.codexCommand,
  });
  const attachServer = new AttachServer({
    socketPath: getAttachSocketPath(),
    eventBus,
    projectManager,
    boundUserId: account.boundUserId,
    sendWechatText: async (text) => sender.sendText(account.boundUserId, "", text),
    modelService,
  });
  await attachServer.start();
  const monitor = new WeChatMonitor(api, {
    onMessage: (message) => bridgeService.handleMessage(message),
    onSessionExpired: () => {
      logger.warn("WeChat session expired");
      console.error("微信登录已过期，请重新运行 npm run setup");
    },
  });

  const shutdown = async () => {
    await attachServer.stop();
    await shutdownProjectBridgeRuntime(monitor, projectManager);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  logger.info("Daemon started", { accountId: account.accountId, boundUserId: account.boundUserId });
  console.log(`wechat-agent-bridge started. Bound user: ${account.boundUserId}`);
  const attachLaunch = launchAttachTerminal({
    cwd: process.cwd(),
    onError: (error) => {
      logger.warn("Failed to open desktop sync terminal", { error: error.message });
    },
  });
  if (attachLaunch.launched) {
    console.log("Desktop sync terminal opened. If it did not appear, run: npm run attach");
  } else if (attachLaunch.reason !== "disabled") {
    console.log(`Desktop sync terminal not opened (${attachLaunch.reason}). Run manually: npm run attach`);
  }
  try {
    await monitor.run();
  } finally {
    await attachServer.stop();
  }
}

export interface BuildProjectBridgeRuntimeOptions {
  account: AccountData;
  config: BridgeConfig;
  sender: WeChatSender;
  backend: AgentBackend;
  codexBin?: string;
  sessionStore?: ProjectSessionStore;
  loadRuntimeState?: () => BridgeRuntimeState;
  saveRuntimeState?: (state: BridgeRuntimeState) => void;
}

export async function buildProjectBridgeRuntime(options: BuildProjectBridgeRuntimeOptions): Promise<{
  bridgeService: BridgeService;
  projectManager: ProjectRuntimeManager;
  eventBus: EventBus;
  modelService: ModelService;
}> {
  const resolvedConfig = await resolveProjectsRootConfig(options.config);
  const catalog = new ProjectCatalog(resolvedConfig.projectsRoot);
  const runtimeState = options.loadRuntimeState?.() ?? loadRuntimeState();
  const initialProject = await catalog.resolveInitialProject(resolvedConfig.defaultProject, runtimeState.lastProject);
  if (runtimeState.lastProject && initialProject.alias !== runtimeState.lastProject) {
    (options.saveRuntimeState ?? saveRuntimeState)({ lastProject: initialProject.alias });
  }
  const extraWritableRoots = await Promise.all((options.config.extraWritableRoots ?? []).map((root) => realpath(root)));
  const projectSessionStore = options.sessionStore ?? new ProjectSessionStore();
  const agentService = new AgentService(options.backend);
  const eventBus = new EventBus();
  const modelService = new ModelService({ codexBin: options.codexBin });
  const projectManager = new ProjectRuntimeManager({
    account: options.account,
    catalog,
    sessionStore: projectSessionStore,
    sender: options.sender,
    agentService,
    streamIntervalMs: options.config.streamIntervalMs,
    extraWritableRoots,
    initialProjectAlias: initialProject.alias,
    defaultProjectAlias: resolvedConfig.defaultProject,
    rememberActiveProject: async (alias) => (options.saveRuntimeState ?? saveRuntimeState)({ lastProject: alias }),
    eventBus,
    modelService,
  });
  const bridgeService = new BridgeService({
    account: options.account,
    projectManager,
    sender: options.sender,
    modelService,
  });
  return { bridgeService, projectManager, eventBus, modelService };
}

async function handleMessageForTestCompat(
  message: WeixinMessage,
  account: AccountData,
  session: BridgeSession,
  sessionStore: SessionStorePort,
  sender: WeChatSender,
  backend: AgentBackend,
  streamIntervalMs: number,
  extraWritableRoots: string[] = [],
): Promise<void> {
  const compatProject = { alias: "default", cwd: session.cwd, ready: true } as const;
  const catalog = {
    async list() {
      return [{ ...compatProject }];
    },
    async get(alias: string) {
      return alias === compatProject.alias ? { ...compatProject } : undefined;
    },
    async resolveInitialProject() {
      return { ...compatProject };
    },
    async init() {
      return { ...compatProject };
    },
  };
  const projectSessionStore = createCompatProjectSessionStore(session, sessionStore);
  const projectManager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: projectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs,
    extraWritableRoots,
    initialProjectAlias: compatProject.alias,
    defaultProjectAlias: compatProject.alias,
  });
  const service = new BridgeService({
    account,
    projectManager,
    sender,
  });
  await service.handleMessage(message);
}

export const handleMessageForTest = handleMessageForTestCompat;

export async function shutdownProjectBridgeRuntime(
  monitor: Pick<WeChatMonitor, "stop">,
  projectManager: Pick<ProjectRuntimeManager, "interruptAll">,
  exit: (code: number) => never | void = process.exit,
): Promise<void> {
  monitor.stop();
  await projectManager.interruptAll();
  exit(0);
}

function createCompatProjectSessionStore(session: BridgeSession, store: SessionStorePort): ProjectSessionStore {
  return {
    async load(userId: string, project: ProjectDefinition, defaults: { resetStaleProcessing?: boolean } = {}): Promise<ProjectSession> {
      session.userId = userId;
      session.cwd = project.cwd;
      session.allowlistRoots = [project.cwd];
      if (defaults.resetStaleProcessing && session.state !== "idle") {
        session.state = "idle";
        delete session.activeTurnId;
      }
      return Object.assign(session, { projectAlias: project.alias });
    },

    async save(projectSession: ProjectSession): Promise<void> {
      Object.assign(session, projectSession);
      await store.save(session);
    },

    async clear(userId: string, project: ProjectDefinition): Promise<ProjectSession> {
      const next = await store.clear(userId, { cwd: project.cwd, allowlistRoots: [project.cwd] });
      Object.assign(session, next, {
        userId,
        projectAlias: project.alias,
        cwd: project.cwd,
        state: "idle",
        codexSessionId: undefined,
        codexThreadId: undefined,
        activeTurnId: undefined,
        allowlistRoots: [project.cwd],
      });
      return session as ProjectSession;
    },

    addHistory(projectSession: ProjectSession, role: "user" | "assistant", content: string): void {
      store.addHistory(projectSession, role, content);
    },

    formatHistory(projectSession: ProjectSession, limit?: number): string {
      return store.formatHistory(projectSession, limit);
    },
  } as ProjectSessionStore;
}
