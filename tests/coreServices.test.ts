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
import { SessionService } from "../src/core/SessionService.js";
import type { AccountData } from "../src/config/accounts.js";
import type { BridgeSession } from "../src/session/types.js";
import { MessageItemType, MessageType, type WeixinMessage } from "../src/wechat/types.js";

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];
  results: AgentTurnResult[];

  constructor(results: AgentTurnResult[] = [{ text: "ok", interrupted: false, codexSessionId: "new-session" }]) {
    this.results = results;
  }

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    return this.results.shift() ?? { text: "ok", interrupted: false, codexSessionId: "new-session" };
  }

  async resumeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
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

class MemorySender {
  messages: string[] = [];

  async sendText(_toUserId: string, _contextToken: string, text: string): Promise<void> {
    this.messages.push(text);
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

function makeBridge(session: BridgeSession, backend = new FakeBackend(), store = new MemorySessionStore(), sender = new MemorySender()): {
  bridge: BridgeService;
  backend: FakeBackend;
  sender: MemorySender;
} {
  const bridge = new BridgeService({
    account,
    session,
    sessionStore: store,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 1,
    extraWritableRoots: ["/tmp/extra"],
  });
  return { bridge, backend, sender };
}

test("BridgeService keeps v1 message filters for strangers, groups and bot messages", async () => {
  const session = makeSession();
  const { bridge, backend, sender } = makeBridge(session);

  await bridge.handleMessage(textMessage("user-2", "hi"));
  await bridge.handleMessage(textMessage("room@chatroom", "hi"));
  await bridge.handleMessage(textMessage("user-1", "hi", MessageType.BOT));

  assert.equal(backend.startRequests.length, 0);
  assert.equal(backend.resumeRequests.length, 0);
  assert.equal(sender.messages.length, 0);
});

test("BridgeService interrupts a processing turn before starting a new ordinary message", async () => {
  const session = makeSession({ state: "processing" });
  const { bridge, backend, sender } = makeBridge(session);

  await bridge.handleMessage(textMessage("user-1", "new task"));

  assert.deepEqual(backend.interrupts, ["user-1"]);
  assert.equal(backend.resumeRequests.length, 1);
  assert.match(sender.messages[0] ?? "", /中断上一轮/);
});

test("BridgeService clear command discards old Codex session ids", async () => {
  const session = makeSession({ codexSessionId: "old-session", codexThreadId: "old-session" });
  const { bridge, backend, sender } = makeBridge(session);

  await bridge.handleMessage(textMessage("user-1", "/clear"));

  assert.deepEqual(backend.interrupts, ["user-1"]);
  assert.equal(session.codexSessionId, undefined);
  assert.equal(session.codexThreadId, undefined);
  assert.match(sender.messages.join("\n"), /会话已清除/);
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
