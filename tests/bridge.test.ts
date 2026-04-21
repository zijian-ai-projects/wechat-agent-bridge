import test from "node:test";
import assert from "node:assert/strict";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { handleMessageForTest } from "../src/runtime/bridge.js";
import { MessageItemType, MessageType, type WeixinMessage } from "../src/wechat/types.js";
import type { AccountData } from "../src/config/accounts.js";
import type { BridgeSession } from "../src/session/types.js";

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];

  constructor(private readonly result: AgentTurnResult = { text: "ok", interrupted: false, codexSessionId: "new-session" }) {}

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    return this.result;
  }

  async resumeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
    return this.result;
  }

  async interrupt(userId: string): Promise<void> {
    this.interrupts.push(userId);
  }

  formatEventForWechat(): string | undefined {
    return undefined;
  }
}

class FakeSessionStore {
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

class FakeSender {
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

function textMessage(fromUserId: string, text: string): WeixinMessage {
  return {
    from_user_id: fromUserId,
    message_type: MessageType.USER,
    context_token: "ctx",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

test("handleMessage ignores stranger and group messages", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession();

  await handleMessageForTest(textMessage("user-2", "hi"), account, session, new FakeSessionStore(), sender, backend, 1);
  await handleMessageForTest(textMessage("room@chatroom", "hi"), account, session, new FakeSessionStore(), sender, backend, 1);

  assert.equal(backend.startRequests.length, 0);
  assert.equal(sender.messages.length, 0);
});

test("new ordinary message interrupts old processing turn before starting new turn", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession({ state: "processing" });

  await handleMessageForTest(textMessage("user-1", "new task"), account, session, new FakeSessionStore(), sender, backend, 1);

  assert.deepEqual(backend.interrupts, ["user-1"]);
  assert.equal(backend.resumeRequests.length, 1);
  assert.match(sender.messages[0] ?? "", /中断上一轮/);
});

test("/clear discards old session id and does not resume old session", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession({ codexSessionId: "old-session", codexThreadId: "old-session" });
  const store = new FakeSessionStore();

  await handleMessageForTest(textMessage("user-1", "/clear"), account, session, store, sender, backend, 1);

  assert.equal(session.codexSessionId, undefined);
  assert.equal(session.codexThreadId, undefined);
  assert.equal(backend.resumeRequests.length, 0);
  assert.match(sender.messages.join("\n"), /会话已清除/);
});
