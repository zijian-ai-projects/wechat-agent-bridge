import test from "node:test";
import assert from "node:assert/strict";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { AgentService } from "../src/core/AgentService.js";
import { ProjectRuntimeManager } from "../src/core/ProjectRuntimeManager.js";
import type { TextSender } from "../src/core/types.js";
import type { AccountData } from "../src/config/accounts.js";
import { ProjectRegistry, type ProjectDefinition } from "../src/config/projects.js";
import type { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { ProjectSession } from "../src/session/types.js";

interface QueuedTurn {
  text: string;
  codexSessionId?: string;
  codexThreadId?: string;
  interrupted?: boolean;
  events?: Array<{ event: unknown; formatted?: string }>;
  waitForRelease?: string;
}

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];
  onInterrupt?: (executionKey: string) => Promise<void> | void;
  private readonly queue: QueuedTurn[] = [];
  private readonly releases = new Map<string, () => void>();

  enqueue(turn: QueuedTurn): void {
    this.queue.push(turn);
  }

  release(key: string): void {
    const release = this.releases.get(key);
    if (!release) throw new Error(`No pending turn: ${key}`);
    release();
    this.releases.delete(key);
  }

  async startTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    return this.runQueuedTurn(callbacks);
  }

  async resumeTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
    return this.runQueuedTurn(callbacks);
  }

  async interrupt(executionKey: string): Promise<void> {
    this.interrupts.push(executionKey);
    await this.onInterrupt?.(executionKey);
  }

  formatEventForWechat(): string | undefined {
    return undefined;
  }

  private async runQueuedTurn(callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void }): Promise<AgentTurnResult> {
    const turn = this.queue.shift() ?? { text: "ok", interrupted: false };
    for (const item of turn.events ?? []) {
      await callbacks.onEvent?.(item.event, item.formatted);
    }
    if (turn.waitForRelease) {
      await new Promise<void>((resolve) => this.releases.set(turn.waitForRelease!, resolve));
    }
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

const account: Pick<AccountData, "boundUserId"> = { boundUserId: "user-1" };
const bridgeProject: ProjectDefinition = { alias: "bridge", cwd: "/tmp/bridge" };
const sageProject: ProjectDefinition = { alias: "SageTalk", cwd: "/tmp/sage" };

function makeManager(options: { streamIntervalMs?: number } = {}): {
  manager: ProjectRuntimeManager;
  backend: FakeBackend;
  store: MemoryProjectSessionStore;
  sender: MemorySender;
} {
  const backend = new FakeBackend();
  const store = new MemoryProjectSessionStore();
  const sender = new MemorySender();
  const manager = new ProjectRuntimeManager({
    account,
    registry: new ProjectRegistry("bridge", new Map([["bridge", bridgeProject], ["SageTalk", sageProject]])),
    sessionStore: store as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: options.streamIntervalMs ?? 0,
    extraWritableRoots: ["/tmp/extra"],
  });
  return { manager, backend, store, sender };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

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
  await Promise.resolve();
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
  await Promise.resolve();
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

test("replacePrompt without an explicit alias keeps the original active project when interrupt changes active project", async () => {
  const { manager, backend } = makeManager();
  backend.onInterrupt = () => {
    manager.setActiveProject("SageTalk");
  };
  backend.enqueue({ text: "replacement" });

  await manager.replacePrompt({ prompt: "replacement", toUserId: "user-1", contextToken: "ctx" });

  assert.deepEqual(backend.interrupts, ["user-1:bridge"]);
  assert.equal(backend.startRequests[0].executionKey, "user-1:bridge");
  assert.equal(backend.startRequests[0].cwd, bridgeProject.cwd);
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
    text: "background result",
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
    ["started", "delta", "completed", "[SageTalk] bg started", "[SageTalk] bg completed", "[SageTalk] 最终结果:\nbackground result"],
  );
});

test("setMode and setModel update only targeted project session", async () => {
  const { manager } = makeManager();

  await manager.setMode("SageTalk", "workspace");
  await manager.setModel("SageTalk", "gpt-5.4-codex");

  const bridge = await manager.session("bridge");
  const sage = await manager.session("SageTalk");
  assert.equal(bridge.mode, "readonly");
  assert.equal(bridge.model, undefined);
  assert.equal(sage.mode, "workspace");
  assert.equal(sage.model, "gpt-5.4-codex");
  await assert.rejects(manager.setMode("bridge", "invalid"), /Invalid mode/);
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
