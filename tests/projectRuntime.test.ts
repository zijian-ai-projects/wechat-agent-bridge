import test from "node:test";
import assert from "node:assert/strict";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { AgentService } from "../src/core/AgentService.js";
import type { BridgeEvent, BridgeEventBus } from "../src/core/EventBus.js";
import type { ModelState } from "../src/core/ModelService.js";
import { ProjectInitRequiredError, ProjectRuntimeManager } from "../src/core/ProjectRuntimeManager.js";
import type { TextSender } from "../src/core/types.js";
import type { AccountData } from "../src/config/accounts.js";
import type { DiscoveredProject, ProjectDefinition } from "../src/config/projects.js";
import type { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { ProjectSession } from "../src/session/types.js";

interface QueuedTurn {
  text: string;
  codexSessionId?: string;
  codexThreadId?: string;
  interrupted?: boolean;
  error?: Error;
  events?: Array<{ event: unknown; formatted?: string }>;
  eventsAfterRelease?: Array<{ event: unknown; formatted?: string }>;
  waitForRelease?: string;
}

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];
  onInterrupt?: (executionKey: string) => Promise<void> | void;
  private latestCallbacks?: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void };
  private readonly queue: QueuedTurn[] = [];
  private readonly releases = new Map<string, () => void>();
  private readonly interruptReleases = new Map<string, () => void>();

  enqueue(turn: QueuedTurn): void {
    this.queue.push(turn);
  }

  release(key: string): void {
    const release = this.releases.get(key);
    if (!release) throw new Error(`No pending turn: ${key}`);
    release();
    this.releases.delete(key);
  }

  releaseInterrupt(key: string): void {
    const release = this.interruptReleases.get(key);
    if (!release) throw new Error(`No pending interrupt: ${key}`);
    release();
    this.interruptReleases.delete(key);
  }

  async startTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    this.latestCallbacks = callbacks;
    return this.runQueuedTurn(callbacks);
  }

  async resumeTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
    this.latestCallbacks = callbacks;
    return this.runQueuedTurn(callbacks);
  }

  async interrupt(executionKey: string): Promise<void> {
    this.interrupts.push(executionKey);
    await this.onInterrupt?.(executionKey);
  }

  async blockInterrupt(key: string): Promise<void> {
    await new Promise<void>((resolve) => this.interruptReleases.set(key, resolve));
  }

  formatEventForWechat(): string | undefined {
    return undefined;
  }

  async emitLatestEvent(event: unknown, formatted?: string): Promise<void> {
    await this.latestCallbacks?.onEvent?.(event, formatted);
  }

  private async runQueuedTurn(callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void }): Promise<AgentTurnResult> {
    const turn = this.queue.shift() ?? { text: "ok", interrupted: false };
    for (const item of turn.events ?? []) {
      await callbacks.onEvent?.(item.event, item.formatted);
    }
    if (turn.waitForRelease) {
      await new Promise<void>((resolve) => this.releases.set(turn.waitForRelease!, resolve));
    }
    for (const item of turn.eventsAfterRelease ?? []) {
      await callbacks.onEvent?.(item.event, item.formatted);
    }
    if (turn.error) throw turn.error;
    return {
      text: turn.text,
      codexSessionId: turn.codexSessionId,
      codexThreadId: turn.codexThreadId,
      interrupted: turn.interrupted ?? false,
    };
  }
}

class MemoryProjectSessionStore {
  readonly sessions = new Map<string, ProjectSession>();
  saves: ProjectSession[] = [];

  async load(userId: string, project: ProjectDefinition, defaults: { resetStaleProcessing?: boolean } = {}): Promise<ProjectSession> {
    const key = this.key(userId, project.alias);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.freshSession(userId, project);
      this.sessions.set(key, session);
    }
    session.userId = userId;
    session.projectAlias = project.alias;
    session.cwd = project.cwd;
    session.allowlistRoots = [project.cwd];
    if (defaults.resetStaleProcessing && session.state !== "idle") {
      session.state = "idle";
      session.activeTurnId = undefined;
    }
    return session;
  }

  async save(session: ProjectSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    this.sessions.set(this.key(session.userId, session.projectAlias), session);
    this.saves.push({ ...session, history: [...session.history], allowlistRoots: [...session.allowlistRoots] });
  }

  async clear(userId: string, project: ProjectDefinition): Promise<ProjectSession> {
    const session = this.freshSession(userId, project);
    this.sessions.set(this.key(userId, project.alias), session);
    await this.save(session);
    return session;
  }

  addHistory(session: ProjectSession, role: "user" | "assistant", content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
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
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  private key(userId: string, alias: string): string {
    return `${userId}:${alias}`;
  }
}

class MemorySender implements TextSender {
  messages: Array<{ toUserId: string; contextToken: string; text: string }> = [];

  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    this.messages.push({ toUserId, contextToken, text });
  }
}

class MemoryProjectCatalog {
  readonly initialized: string[] = [];

  constructor(readonly projects: DiscoveredProject[]) {}

  async list(): Promise<DiscoveredProject[]> {
    return this.projects.map((project) => ({ ...project }));
  }

  async get(alias: string): Promise<DiscoveredProject | undefined> {
    return this.projects.find((project) => project.alias === alias);
  }

  async resolveInitialProject(defaultProject: string, lastProject?: string): Promise<DiscoveredProject> {
    return (await this.get(lastProject ?? "")) ?? (await this.get(defaultProject))!;
  }

  async init(alias: string): Promise<DiscoveredProject> {
    const project = this.projects.find((item) => item.alias === alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    project.ready = true;
    this.initialized.push(alias);
    return { ...project };
  }
}

const account: Pick<AccountData, "boundUserId"> = { boundUserId: "user-1" };
const bridgeProject: DiscoveredProject = { alias: "bridge", cwd: "/tmp/bridge", ready: true };
const sageProject: DiscoveredProject = { alias: "SageTalk", cwd: "/tmp/sage", ready: true };

function makeManager(
  options: {
    streamIntervalMs?: number;
    projects?: DiscoveredProject[];
    initialProjectAlias?: string;
    defaultProjectAlias?: string;
    rememberActiveProject?: (alias: string) => Promise<void> | void;
    eventBus?: BridgeEventBus;
    modelService?: { describeSession(session: ProjectSession): Promise<ModelState> };
  } = {},
): {
  manager: ProjectRuntimeManager;
  backend: FakeBackend;
  store: MemoryProjectSessionStore;
  sender: MemorySender;
  catalog: MemoryProjectCatalog;
} {
  const backend = new FakeBackend();
  const store = new MemoryProjectSessionStore();
  const sender = new MemorySender();
  const catalog = new MemoryProjectCatalog((options.projects ?? [bridgeProject, sageProject]).map((project) => ({ ...project })));
  const manager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: store as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: options.streamIntervalMs ?? 0,
    extraWritableRoots: ["/tmp/extra"],
    initialProjectAlias: options.initialProjectAlias ?? "bridge",
    defaultProjectAlias: options.defaultProjectAlias ?? "bridge",
    rememberActiveProject: options.rememberActiveProject,
    eventBus: options.eventBus,
    modelService: options.modelService,
  });
  return { manager, backend, store, sender, catalog };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

test("setActiveProject persists the selected project name", async () => {
  const remembered: string[] = [];
  const { manager } = makeManager({
    rememberActiveProject: async (alias) => {
      remembered.push(alias);
    },
  });

  await manager.setActiveProject("SageTalk");

  assert.equal(manager.activeProjectAlias, "SageTalk");
  assert.deepEqual(remembered, ["SageTalk"]);
});

test("initializeProject marks a child ready, switches to it, and persists the selection", async () => {
  const remembered: string[] = [];
  const { manager, catalog } = makeManager({
    projects: [
      bridgeProject,
      { alias: "scratch", cwd: "/tmp/scratch", ready: false },
    ],
    rememberActiveProject: async (alias) => {
      remembered.push(alias);
    },
  });

  const project = await manager.initializeProject("scratch");

  assert.equal(project.ready, true);
  assert.equal(manager.activeProjectAlias, "scratch");
  assert.deepEqual(catalog.initialized, ["scratch"]);
  assert.deepEqual(remembered, ["scratch"]);
});

test("listProjects reflects newly added child directories without restarting the manager", async () => {
  const { manager, catalog } = makeManager({ projects: [bridgeProject] });

  assert.deepEqual(
    (await manager.listProjects()).map((project) => project.alias),
    ["bridge"],
  );

  catalog.projects.push({ alias: "SageTalk", cwd: "/tmp/sage", ready: true });

  assert.deepEqual(
    (await manager.listProjects()).map((project) => project.alias),
    ["bridge", "SageTalk"],
  );
});

test("missing active project falls back to the configured default project and remembers it", async () => {
  const remembered: string[] = [];
  const { manager } = makeManager({
    initialProjectAlias: "deleted-project",
    defaultProjectAlias: "bridge",
    rememberActiveProject: async (alias) => {
      remembered.push(alias);
    },
  });

  const session = await manager.session();

  assert.equal(session.projectAlias, "bridge");
  assert.equal(manager.activeProjectAlias, "bridge");
  assert.deepEqual(remembered, ["bridge"]);
});

test("runtime execution rejects non-git projects until they are initialized", async () => {
  const { manager, backend } = makeManager({
    projects: [
      bridgeProject,
      { alias: "scratch", cwd: "/tmp/scratch", ready: false },
    ],
  });

  await assert.rejects(
    manager.runPrompt({ projectAlias: "scratch", prompt: "run tests", toUserId: "user-1", contextToken: "ctx" }),
    ProjectInitRequiredError,
  );
  assert.equal(backend.startRequests.length, 0);
});

test("ProjectRuntimeManager publishes user and turn events", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
    modelService: {
      describeSession: async () => ({ effectiveModel: "gpt-5.5", source: "project override" }),
    },
  });
  backend.enqueue({ text: "done", events: [{ event: { type: "turn.started" }, formatted: "Codex 开始处理" }] });

  await manager.runPrompt({ projectAlias: "bridge", prompt: "hi", toUserId: "user-1", contextToken: "ctx", source: "wechat" });

  assert.deepEqual(
    events.map((event) => event.type),
    ["user_message", "turn_started", "codex_event", "turn_completed", "state"],
  );
  const [userMessage, turnStarted, codexEvent, turnCompleted, state] = events;
  assert.equal(userMessage?.type, "user_message");
  assert.equal(userMessage?.source, "wechat");
  assert.equal(userMessage?.project, "bridge");
  assert.equal(userMessage?.text, "hi");
  assert.equal(turnStarted?.type, "turn_started");
  assert.equal(turnStarted?.model, "gpt-5.5");
  assert.equal(turnStarted?.modelSource, "project override");
  assert.equal(codexEvent?.type, "codex_event");
  assert.equal(codexEvent?.text, "Codex 开始处理");
  assert.equal(turnCompleted?.type, "turn_completed");
  assert.equal(turnCompleted?.text, "done");
  assert.equal(state?.type, "state");
  assert.equal(state?.state, "idle");
});

test("runtime events use fallback model state when model lookup fails", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
    modelService: {
      describeSession: async () => {
        throw new Error("model unavailable");
      },
    },
  });
  backend.enqueue({ text: "done" });

  await manager.runPrompt({ projectAlias: "bridge", prompt: "hi", toUserId: "user-1", contextToken: "ctx" });

  assert.equal(backend.startRequests.length, 1);
  const turnStarted = events.find((event) => event.type === "turn_started");
  const state = events.find((event) => event.type === "state");
  assert.equal(turnStarted?.type, "turn_started");
  assert.equal(turnStarted?.model, "Codex CLI default");
  assert.equal(turnStarted?.modelSource, "unresolved");
  assert.equal(state?.type, "state");
  assert.equal(state?.model, "Codex CLI default");
  assert.equal(state?.modelSource, "unresolved");
});

test("busy-rejected prompts do not publish phantom user messages", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
  });
  backend.enqueue({ text: "done", waitForRelease: "bridge" });

  const first = manager.runPrompt({ projectAlias: "bridge", prompt: "first", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => backend.startRequests.length === 1);
  await manager.runPrompt({ projectAlias: "bridge", prompt: "second", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(
    events.filter((event) => event.type === "user_message").map((event) => (event.type === "user_message" ? event.text : "")),
    ["first"],
  );

  backend.release("bridge");
  await first;
});

test("accepted callbacks run before the runtime turn completes", async () => {
  const accepted: string[] = [];
  const { manager, backend } = makeManager();
  backend.enqueue({ text: "done", waitForRelease: "bridge" });

  let completed = false;
  const run = manager
    .runPrompt({
      projectAlias: "bridge",
      prompt: "long task",
      toUserId: "user-1",
      contextToken: "ctx",
      onAccepted: (projectAlias) => {
        accepted.push(projectAlias);
      },
    })
    .then(() => {
      completed = true;
    });
  await waitFor(() => backend.startRequests.length === 1);

  assert.deepEqual(accepted, ["bridge"]);
  assert.equal(completed, false);

  backend.release("bridge");
  await run;
});

test("interrupt after prompt acceptance prevents backend start before the turn begins", async () => {
  let accepted = false;
  let modelLookupStarted = false;
  let releaseModelLookup: (() => void) | undefined;
  const { manager, backend } = makeManager({
    modelService: {
      describeSession: async () => {
        if (!modelLookupStarted) {
          modelLookupStarted = true;
          await new Promise<void>((resolve) => {
            releaseModelLookup = resolve;
          });
        }
        return { effectiveModel: "gpt-5.5", source: "project override" };
      },
    },
  });

  const run = manager.runPrompt({
    projectAlias: "bridge",
    prompt: "long task",
    toUserId: "user-1",
    contextToken: "ctx",
    onAccepted: () => {
      accepted = true;
    },
  });
  await waitFor(() => accepted && modelLookupStarted);

  await manager.interrupt("bridge");
  releaseModelLookup?.();
  await run;

  assert.equal(backend.startRequests.length, 0);
});

test("interrupt publishes an idle state event", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
  });
  backend.enqueue({ text: "old result", waitForRelease: "bridge" });

  const run = manager.runPrompt({ projectAlias: "bridge", prompt: "old", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => events.some((event) => event.type === "turn_started"));
  await manager.interrupt("bridge");

  assert.ok(events.some((event) => event.type === "state" && event.state === "idle"));

  backend.release("bridge");
  await run;
});

test("background delivery failure publishes only a failed terminal event", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend, sender } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
  });
  sender.sendText = async () => {
    throw new Error("wechat down");
  };
  backend.enqueue({ text: "done" });

  await assert.rejects(
    manager.runPrompt({ projectAlias: "SageTalk", prompt: "background", toUserId: "user-1", contextToken: "ctx" }),
    /wechat down/,
  );

  assert.deepEqual(
    events.filter((event) => event.type === "turn_completed" || event.type === "turn_failed").map((event) => event.type),
    ["turn_failed"],
  );
});

test("interrupted turn does not publish completion after final delivery unblocks", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend, sender } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
  });
  let deliveryStarted = false;
  let releaseDelivery: (() => void) | undefined;
  sender.sendText = async () => {
    deliveryStarted = true;
    await new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
  };
  backend.enqueue({ text: "done" });

  const run = manager.runPrompt({ projectAlias: "SageTalk", prompt: "background", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => deliveryStarted);
  await manager.interrupt("SageTalk");
  releaseDelivery?.();
  await run;

  assert.equal(events.some((event) => event.type === "turn_completed"), false);
  assert.ok(events.some((event) => event.type === "state" && event.state === "idle"));
});

test("successful no-text turns publish completion without text", async () => {
  const events: BridgeEvent[] = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
  });
  backend.enqueue({ text: "" });

  await manager.runPrompt({ projectAlias: "bridge", prompt: "empty", toUserId: "user-1", contextToken: "ctx" });

  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.type, "turn_completed");
  assert.equal(completed?.text, undefined);
});

test("state event uses an idle snapshot even if the session changes during model lookup", async () => {
  const events: BridgeEvent[] = [];
  let lookupCount = 0;
  const releaseModelLookups: Array<() => void> = [];
  const { manager, backend } = makeManager({
    eventBus: {
      publish: async (event) => {
        events.push(event);
      },
      subscribe: () => () => undefined,
    },
    modelService: {
      describeSession: async () => {
        lookupCount += 1;
        await new Promise<void>((resolve) => {
          releaseModelLookups.push(resolve);
        });
        return { effectiveModel: "gpt-5.5", source: "project override" };
      },
    },
  });
  backend.enqueue({ text: "done" });

  const run = manager.runPrompt({ projectAlias: "bridge", prompt: "done", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => lookupCount === 1 && releaseModelLookups.length === 1);
  releaseModelLookups.shift()?.();
  await waitFor(() => events.some((event) => event.type === "turn_started"));
  await waitFor(() => lookupCount === 2 && releaseModelLookups.length === 1);
  const session = await manager.session("bridge");
  session.state = "processing";
  releaseModelLookups.shift()?.();
  await run;
  await waitFor(() => events.some((event) => event.type === "state"));

  const state = events.find((event) => event.type === "state");
  assert.equal(state?.type, "state");
  assert.equal(state?.state, "idle");
});

test("onAccepted failures do not leave the project processing", async () => {
  const { manager } = makeManager({
    eventBus: {
      publish: () => {
        throw new Error("publish failed");
      },
      subscribe: () => () => undefined,
    },
  });

  await manager.runPrompt({ projectAlias: "bridge", prompt: "hi", toUserId: "user-1", contextToken: "ctx" });

  assert.equal((await manager.session("bridge")).state, "idle");
});

test("different projects run concurrently with separate execution keys", async () => {
  const { manager, backend } = makeManager();
  backend.enqueue({ text: "bridge done", waitForRelease: "bridge" });
  backend.enqueue({ text: "sage done", waitForRelease: "sage" });

  const bridgeRun = manager.runPrompt({ projectAlias: "bridge", prompt: "bridge task", toUserId: "user-1", contextToken: "ctx" });
  const sageRun = manager.runPrompt({ projectAlias: "SageTalk", prompt: "sage task", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => backend.startRequests.length === 2);

  assert.deepEqual(
    backend.startRequests.map((request) => request.executionKey),
    ["user-1:bridge", "user-1:SageTalk"],
  );

  backend.release("bridge");
  backend.release("sage");
  await Promise.all([bridgeRun, sageRun]);
});

test("same busy project rejects a second prompt without starting another backend turn", async () => {
  const { manager, backend, sender } = makeManager();
  backend.enqueue({ text: "done", waitForRelease: "bridge" });

  const first = manager.runPrompt({ projectAlias: "bridge", prompt: "first", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => backend.startRequests.length === 1);
  await manager.runPrompt({ projectAlias: "bridge", prompt: "second", toUserId: "user-1", contextToken: "ctx" });

  assert.equal(backend.startRequests.length, 1);
  assert.equal(sender.messages.at(-1)?.text, "[bridge] 正在处理上一轮任务。请使用 /interrupt bridge 或 /replace bridge <prompt>。");

  backend.release("bridge");
  await first;
});

test("replacePrompt interrupts target execution key then starts replacement prompt", async () => {
  const { manager, backend } = makeManager();
  backend.enqueue({ text: "first", waitForRelease: "bridge" });
  backend.enqueue({ text: "replacement" });

  const first = manager.runPrompt({ projectAlias: "bridge", prompt: "first", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => backend.startRequests.length === 1);
  await manager.replacePrompt({ projectAlias: "bridge", prompt: "replacement", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(backend.interrupts, ["user-1:bridge"]);
  assert.equal(backend.startRequests.length, 2);
  assert.equal(backend.startRequests[1].prompt, "replacement");

  backend.release("bridge");
  await first;
});

test("interrupt prevents stale buffered output from an old project turn", async () => {
  const { manager, backend, sender } = makeManager({ streamIntervalMs: 10_000 });
  backend.enqueue({
    text: "old result",
    waitForRelease: "old",
    events: [
      { event: { type: "turn.started" }, formatted: "first progress" },
      { event: { type: "item.completed" }, formatted: "stale buffered progress" },
    ],
  });

  const oldRun = manager.runPrompt({ projectAlias: "bridge", prompt: "old", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => sender.messages.some((message) => message.text.includes("first progress")));
  await manager.interrupt("bridge");
  backend.release("old");
  await oldRun;

  const texts = sender.messages.map((message) => message.text);
  assert.ok(texts.some((text) => text.includes("first progress")));
  assert.equal(texts.some((text) => text.includes("stale buffered progress")), false);
});

test("interrupt invalidates the active turn before backend interrupt can emit trailing events", async () => {
  const { manager, backend, sender } = makeManager();
  backend.enqueue({
    text: "old result",
    waitForRelease: "old",
    events: [{ event: { type: "turn.started" }, formatted: "first progress" }],
  });
  backend.onInterrupt = async () => {
    await backend.emitLatestEvent({ type: "item.completed" }, "interrupt-time stale progress");
  };

  const oldRun = manager.runPrompt({ projectAlias: "bridge", prompt: "old", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => sender.messages.some((message) => message.text === "first progress"));
  await manager.interrupt("bridge");
  backend.release("old");
  await oldRun;

  const texts = sender.messages.map((message) => message.text);
  assert.ok(texts.includes("first progress"));
  assert.equal(texts.some((text) => text.includes("interrupt-time stale progress")), false);
});

test("same-project prompt does not start while backend interrupt is still pending", async () => {
  const { manager, backend, sender } = makeManager();
  backend.enqueue({
    text: "old result",
    waitForRelease: "old",
    events: [{ event: { type: "turn.started" }, formatted: "old started" }],
  });
  backend.enqueue({ text: "new result" });
  backend.onInterrupt = () => backend.blockInterrupt("bridge");

  const oldRun = manager.runPrompt({ projectAlias: "bridge", prompt: "old", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => sender.messages.some((message) => message.text === "old started"));
  const interruptRun = manager.interrupt("bridge");
  await waitFor(() => backend.interrupts.length === 1);
  await manager.runPrompt({ projectAlias: "bridge", prompt: "new while interrupting", toUserId: "user-1", contextToken: "ctx" });

  assert.equal(backend.startRequests.length, 1);
  assert.equal(sender.messages.at(-1)?.text, "[bridge] 正在处理上一轮任务。请使用 /interrupt bridge 或 /replace bridge <prompt>。");

  backend.releaseInterrupt("bridge");
  await interruptRun;
  backend.release("old");
  await oldRun;

  await manager.runPrompt({ projectAlias: "bridge", prompt: "new after interrupt", toUserId: "user-1", contextToken: "ctx" });
  assert.equal(backend.startRequests.length, 2);
  assert.equal(backend.startRequests[1].prompt, "new after interrupt");
});

test("replacePrompt without an explicit alias keeps the original active project when interrupt changes active project", async () => {
  const { manager, backend } = makeManager();
  backend.onInterrupt = async () => {
    await manager.setActiveProject("SageTalk");
  };
  backend.enqueue({ text: "replacement" });

  await manager.replacePrompt({ prompt: "replacement", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(backend.interrupts, ["user-1:bridge"]);
  assert.equal(backend.startRequests[0].executionKey, "user-1:bridge");
  assert.equal(backend.startRequests[0].cwd, bridgeProject.cwd);
});

test("running active project output becomes prefixed when the project moves to background", async () => {
  const { manager, backend, sender } = makeManager({ streamIntervalMs: 10_000 });
  backend.enqueue({
    text: "bridge final",
    waitForRelease: "bridge",
    events: [
      { event: { type: "turn.started" }, formatted: "first active progress" },
      { event: { type: "item.completed" }, formatted: "buffered after background\nsecond line" },
    ],
  });

  const bridgeRun = manager.runPrompt({ projectAlias: "bridge", prompt: "bridge", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => sender.messages.some((message) => message.text === "first active progress"));
  await manager.setActiveProject("SageTalk");
  backend.release("bridge");
  await bridgeRun;

  assert.deepEqual(
    sender.messages.map((message) => message.text),
    [
      "first active progress",
      "[bridge] buffered after background\n[bridge] second line",
      "[bridge] 最终结果:\n[bridge] bridge final",
    ],
  );
});

test("running background project output becomes unprefixed and complete when the project becomes active", async () => {
  const { manager, backend, sender } = makeManager({ streamIntervalMs: 10_000 });
  backend.enqueue({
    text: "sage final",
    waitForRelease: "sage",
    events: [{ event: { type: "turn.started" }, formatted: "sage started" }],
    eventsAfterRelease: [{ event: { type: "item.completed" }, formatted: "active non-lifecycle" }],
  });

  const sageRun = manager.runPrompt({ projectAlias: "SageTalk", prompt: "sage", toUserId: "user-1", contextToken: "ctx" });
  await waitFor(() => sender.messages.some((message) => message.text === "[SageTalk] sage started"));
  await manager.setActiveProject("SageTalk");
  backend.release("sage");
  await sageRun;

  assert.deepEqual(
    sender.messages.map((message) => message.text),
    ["[SageTalk] sage started", "active non-lifecycle"],
  );
});

test("active project streams all formatted events while background project only streams lifecycle and final output with prefix", async () => {
  const { manager, backend, sender } = makeManager();
  backend.enqueue({
    text: "active result",
    events: [
      { event: { type: "turn.started" }, formatted: "started" },
      { event: { type: "agent.delta" }, formatted: "delta" },
      { event: { type: "turn.completed" }, formatted: "completed" },
    ],
  });
  backend.enqueue({
    text: "line 1\nline 2",
    events: [
      { event: { type: "turn.started" }, formatted: "bg started" },
      { event: { type: "agent.delta" }, formatted: "bg delta" },
      { event: { type: "turn.completed" }, formatted: "bg completed" },
    ],
  });

  await manager.runPrompt({ projectAlias: "bridge", prompt: "active", toUserId: "user-1", contextToken: "ctx" });
  await manager.runPrompt({ projectAlias: "SageTalk", prompt: "background", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(
    sender.messages.map((message) => message.text),
    [
      "started",
      "delta",
      "completed",
      "[SageTalk] bg started",
      "[SageTalk] bg completed",
      "[SageTalk] 最终结果:\n[SageTalk] line 1\n[SageTalk] line 2",
    ],
  );
});

test("background multiline errors prefix every line", async () => {
  const { manager, backend, sender } = makeManager();
  backend.enqueue({ text: "", error: new Error("line 1\nline 2") });

  await manager.runPrompt({ projectAlias: "SageTalk", prompt: "background error", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(sender.messages.map((message) => message.text), [
    "[SageTalk] Codex 处理失败: line 1\n[SageTalk] line 2",
  ]);
});

test("setMode and setModel update only targeted project session", async () => {
  const { manager } = makeManager();

  await manager.setMode("SageTalk", "workspace");
  await manager.setModel("SageTalk", "gpt-5.4-codex");
  await manager.setActiveProject("bridge");
  await manager.setMode(undefined, "yolo");
  await manager.setModel(undefined, "  active-model  ");

  const bridge = await manager.session("bridge");
  const sage = await manager.session("SageTalk");
  assert.equal(bridge.mode, "yolo");
  assert.equal(bridge.model, "active-model");
  assert.equal(sage.mode, "workspace");
  assert.equal(sage.model, "gpt-5.4-codex");
  await manager.setModel(undefined, "   ");
  assert.equal((await manager.session("bridge")).model, undefined);
  await assert.rejects(manager.setMode("bridge", "invalid"), /Invalid mode/);
});

test("manager exposes active project state in activeProjectAlias and listProjects", async () => {
  const { manager } = makeManager();

  assert.equal(manager.activeProjectAlias, "bridge");
  assert.deepEqual(await manager.listProjects(), [
    { alias: "bridge", cwd: bridgeProject.cwd, ready: true, active: true },
    { alias: "SageTalk", cwd: sageProject.cwd, ready: true, active: false },
  ]);

  await manager.setActiveProject("SageTalk");

  assert.equal(manager.activeProjectAlias, "SageTalk");
  assert.deepEqual(await manager.listProjects(), [
    { alias: "bridge", cwd: bridgeProject.cwd, ready: true, active: false },
    { alias: "SageTalk", cwd: sageProject.cwd, ready: true, active: true },
  ]);
});

test("clear resets only the targeted project session", async () => {
  const { manager } = makeManager();
  await manager.setMode("bridge", "workspace");
  await manager.setModel("bridge", "bridge-model");
  await manager.setMode("SageTalk", "yolo");
  await manager.setModel("SageTalk", "sage-model");

  await manager.clear("bridge");

  const bridge = await manager.session("bridge");
  const sage = await manager.session("SageTalk");
  assert.equal(bridge.mode, "readonly");
  assert.equal(bridge.model, undefined);
  assert.equal(sage.mode, "yolo");
  assert.equal(sage.model, "sage-model");
});
