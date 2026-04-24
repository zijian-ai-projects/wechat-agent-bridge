import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { AgentService } from "../src/core/AgentService.js";
import { BridgeService } from "../src/core/BridgeService.js";
import { ModeService } from "../src/core/ModeService.js";
import { ProjectRuntimeManager } from "../src/core/ProjectRuntimeManager.js";
import { SessionService } from "../src/core/SessionService.js";
import type { AccountData } from "../src/config/accounts.js";
import type { DiscoveredProject, ProjectDefinition } from "../src/config/projects.js";
import type { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { BridgeSession } from "../src/session/types.js";
import { MessageItemType, MessageType, type WeixinMessage } from "../src/wechat/types.js";

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];
  results: AgentTurnResult[];
  release?: () => void;

  constructor(results: AgentTurnResult[] = [{ text: "ok", interrupted: false, codexSessionId: "new-session" }]) {
    this.results = results;
  }

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    if (this.results.length === 0) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.results.shift() ?? { text: "ok", interrupted: false, codexSessionId: "new-session" };
  }

  async resumeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
    if (this.results.length === 0) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.results.shift() ?? { text: "ok", interrupted: false, codexSessionId: request.codexSessionId };
  }

  async interrupt(executionKey: string): Promise<void> {
    this.interrupts.push(executionKey);
  }

  formatEventForWechat(): string | undefined {
    return undefined;
  }
}

class MemorySessionStore {
  saves = 0;

  async save(_session: BridgeSession): Promise<void> {
    this.saves += 1;
  }

  async clear(userId: string, defaults: { cwd: string; allowlistRoots: string[] }): Promise<BridgeSession> {
    return makeSession({ userId, cwd: defaults.cwd, allowlistRoots: defaults.allowlistRoots, codexSessionId: undefined });
  }

  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
  }

  formatHistory(session: BridgeSession): string {
    return `${session.history.length}`;
  }
}

class MemoryProjectSessionStore {
  readonly sessions = new Map<string, BridgeSession & { projectAlias: string }>();

  async load(userId: string, project: ProjectDefinition, defaults: { resetStaleProcessing?: boolean } = {}): Promise<BridgeSession & { projectAlias: string }> {
    const key = `${userId}:${project.alias}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = { ...makeSession({ userId, cwd: project.cwd, allowlistRoots: [project.cwd], codexSessionId: undefined }), projectAlias: project.alias };
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

  async save(session: BridgeSession & { projectAlias: string }): Promise<void> {
    this.sessions.set(`${session.userId}:${session.projectAlias}`, session);
  }

  async clear(userId: string, project: ProjectDefinition): Promise<BridgeSession & { projectAlias: string }> {
    const session = { ...makeSession({ userId, cwd: project.cwd, allowlistRoots: [project.cwd], codexSessionId: undefined }), projectAlias: project.alias };
    this.sessions.set(`${userId}:${project.alias}`, session);
    return session;
  }

  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
  }

  formatHistory(session: BridgeSession): string {
    return `${session.history.length}`;
  }
}

class MemorySender {
  messages: string[] = [];
  deliveries: Array<{ toUserId: string; contextToken: string; text: string }> = [];

  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    this.messages.push(text);
    this.deliveries.push({ toUserId, contextToken, text });
  }
}

class FakeProjectManager {
  activeProjectAlias = "bridge";
  prompts: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string }> = [];
  replacements: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string }> = [];
  clears: Array<string | undefined> = [];

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return [
      { alias: "bridge", cwd: "/tmp/bridge", ready: true, active: this.activeProjectAlias === "bridge" },
      { alias: "SageTalk", cwd: "/tmp/sage", ready: true, active: this.activeProjectAlias === "SageTalk" },
    ];
  }

  async setActiveProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    const project = (await this.listProjects()).find((item) => item.alias === alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    this.activeProjectAlias = alias;
    return project;
  }

  async initializeProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    return this.setActiveProject(alias);
  }

  async runPrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string }): Promise<void> {
    this.prompts.push(options);
  }

  async replacePrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string }): Promise<void> {
    this.replacements.push(options);
  }

  async interrupt(): Promise<void> {}

  async clear(alias?: string): Promise<BridgeSession & { projectAlias: string }> {
    this.clears.push(alias);
    return { ...makeSession({ cwd: alias === "SageTalk" ? "/tmp/sage" : "/tmp/bridge" }), projectAlias: alias ?? this.activeProjectAlias };
  }

  async setMode(_alias: string | undefined, mode: string): Promise<BridgeSession & { projectAlias: string }> {
    return { ...makeSession({ mode: mode as BridgeSession["mode"] }), projectAlias: this.activeProjectAlias };
  }

  async setModel(_alias: string | undefined, model: string | undefined): Promise<BridgeSession & { projectAlias: string }> {
    return { ...makeSession({ model }), projectAlias: this.activeProjectAlias };
  }

  async session(alias = this.activeProjectAlias): Promise<BridgeSession & { projectAlias: string }> {
    return { ...makeSession({ cwd: alias === "SageTalk" ? "/tmp/sage" : "/tmp/bridge" }), projectAlias: alias };
  }
}

const account: AccountData = {
  accountId: "bot-1",
  botToken: "token",
  boundUserId: "user-1",
  baseUrl: "https://ilinkai.weixin.qq.com",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    userId: "user-1",
    state: "idle",
    cwd: "/tmp/repo",
    mode: "readonly",
    codexSessionId: "old-session",
    codexThreadId: "old-session",
    history: [],
    allowlistRoots: ["/tmp/repo"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function textMessage(fromUserId: string, text: string, messageType = MessageType.USER): WeixinMessage {
  return {
    from_user_id: fromUserId,
    message_type: messageType,
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function makeProjectBridge(projectManager = new FakeProjectManager(), sender = new MemorySender()): {
  bridge: BridgeService;
  projectManager: FakeProjectManager;
  sender: MemorySender;
} {
  const bridge = new BridgeService({ account, projectManager, sender });
  return { bridge, projectManager, sender };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

test("BridgeService keeps v1 message filters for strangers, groups and bot messages", async () => {
  const { bridge, projectManager, sender } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-2", "hi"));
  await bridge.handleMessage(textMessage("room@chatroom", "hi"));
  await bridge.handleMessage(textMessage("user-1", "hi", MessageType.BOT));

  assert.equal(projectManager.prompts.length, 0);
  assert.equal(projectManager.replacements.length, 0);
  assert.equal(sender.messages.length, 0);
});

test("BridgeService routes @Project prompts without changing active project", async () => {
  const { bridge, projectManager } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "@SageTalk run tests"));

  assert.equal(projectManager.activeProjectAlias, "bridge");
  assert.deepEqual(projectManager.prompts, [{ projectAlias: "SageTalk", prompt: "run tests", toUserId: "user-1", contextToken: "ctx" }]);
});

test("BridgeService replies clearly for unknown @Project prompts", async () => {
  const { bridge, projectManager, sender } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "@Missing run tests"));

  assert.equal(projectManager.prompts.length, 0);
  assert.match(sender.messages[0] ?? "", /未知项目: Missing/);
  assert.match(sender.messages[0] ?? "", /bridge/);
  assert.match(sender.messages[0] ?? "", /SageTalk/);
});

test("BridgeService routes ordinary prompts to the active project with full text", async () => {
  const { bridge, projectManager } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "  keep literal spacing"));

  assert.deepEqual(projectManager.prompts, [{ prompt: "  keep literal spacing", toUserId: "user-1", contextToken: "ctx" }]);
});

test("BridgeService passes WeChat routing context into replace commands", async () => {
  const { bridge, projectManager, sender } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "/replace SageTalk fix tests"));

  assert.deepEqual(projectManager.replacements, [
    { projectAlias: "SageTalk", prompt: "fix tests", toUserId: "user-1", contextToken: "ctx" },
  ]);
  assert.match(sender.messages.join("\n"), /已替换项目 SageTalk/);
});

test("BridgeService clear command clears project session through project manager", async () => {
  const { bridge, projectManager, sender } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "/clear"));

  assert.deepEqual(projectManager.clears, [undefined]);
  assert.match(sender.messages.join("\n"), /项目 bridge 会话已清除/);
});

test("BridgeService rejects same-project prompt while busy", async () => {
  const backend = new FakeBackend([]);
  const sender = new MemorySender();
  const catalog = {
    async list(): Promise<DiscoveredProject[]> {
      return [{ alias: "bridge", cwd: "/tmp/bridge", ready: true }];
    },
    async get(alias: string): Promise<DiscoveredProject | undefined> {
      return alias === "bridge" ? { alias: "bridge", cwd: "/tmp/bridge", ready: true } : undefined;
    },
    async resolveInitialProject(): Promise<DiscoveredProject> {
      return { alias: "bridge", cwd: "/tmp/bridge", ready: true };
    },
    async init(): Promise<DiscoveredProject> {
      return { alias: "bridge", cwd: "/tmp/bridge", ready: true };
    },
  };
  const manager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: new MemoryProjectSessionStore() as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 1,
    initialProjectAlias: "bridge",
    defaultProjectAlias: "bridge",
  });
  const bridge = new BridgeService({ account, projectManager: manager, sender });

  const first = bridge.handleMessage(textMessage("user-1", "first"));
  await waitFor(() => backend.startRequests.length === 1);
  await bridge.handleMessage(textMessage("user-1", "second"));

  assert.equal(backend.startRequests.length, 1);
  assert.match(sender.messages.at(-1) ?? "", /正在处理上一轮任务/);
  assert.equal(backend.interrupts.length, 0);

  backend.release?.();
  await first;
});

test("AgentService falls back to a fresh turn when resume returns no text or session id", async () => {
  const backend = new FakeBackend([
    { text: "", interrupted: false },
    { text: "fresh", interrupted: false, codexSessionId: "fresh-session" },
  ]);
  const service = new AgentService(backend);

  const result = await service.runTurn({
    userId: "user-1",
    prompt: "continue",
    cwd: "/tmp/repo",
    mode: "readonly",
    codexSessionId: "stale-session",
  });

  assert.equal(result.text, "fresh");
  assert.equal(result.codexSessionId, "fresh-session");
  assert.equal(backend.resumeRequests.length, 1);
  assert.equal(backend.startRequests.length, 1);
});

test("AgentService interrupts by execution key", async () => {
  const backend = new FakeBackend();
  const service = new AgentService(backend);

  await service.interrupt("user-1:SageTalk");

  assert.deepEqual(backend.interrupts, ["user-1:SageTalk"]);
});

test("ModeService enforces cwd allowlist repo roots", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-core-mode-")));
  mkdirSync(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const child = join(root, "child");
  mkdirSync(child);
  const outside = await realpath(mkdtempSync(join(tmpdir(), "wcb-core-outside-")));
  const session = makeSession({ cwd: root, allowlistRoots: [root] });
  const service = new ModeService();

  const accepted = await service.setCwd(session, root);
  assert.equal(accepted.cwd, root);
  assert.equal(session.cwd, root);

  await assert.rejects(service.setCwd(session, child), /allowlist repo root|允许/);
  await assert.rejects(service.setCwd(session, outside), /allowlist repo root|允许/);
  assert.equal(session.cwd, root);

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("SessionService exposes stable status and history data for tools", async () => {
  const store = new MemorySessionStore();
  const session = makeSession({ history: [{ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" }] });
  const service = new SessionService(store);

  const status = service.status(session, account.boundUserId);
  assert.equal(status.userId, "user-1");
  assert.equal(status.codexSessionId, "old-session");
  assert.equal(status.historyCount, 1);
  assert.equal(service.history(session, 10), "1");
});
