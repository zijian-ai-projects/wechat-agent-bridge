import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { buildProjectBridgeRuntime, handleMessageForTest, shutdownProjectBridgeRuntime } from "../src/runtime/bridge.js";
import type { BridgeConfig } from "../src/config/config.js";
import { ProjectSessionStore } from "../src/session/projectSessionStore.js";
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

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
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

test("ordinary messages preserve leading whitespace through the compat project manager", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession({ codexSessionId: undefined, codexThreadId: undefined });

  await handleMessageForTest(textMessage("user-1", "  keep literal spacing"), account, session, new FakeSessionStore(), sender, backend, 1);

  assert.equal(backend.startRequests.length, 1);
  assert.equal(backend.startRequests[0]?.prompt, "  keep literal spacing");
});

test("new ordinary message rejects same-project busy turn without interrupting it", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession({ state: "processing" });

  await handleMessageForTest(textMessage("user-1", "new task"), account, session, new FakeSessionStore(), sender, backend, 1);

  assert.deepEqual(backend.interrupts, []);
  assert.equal(backend.startRequests.length, 0);
  assert.equal(backend.resumeRequests.length, 0);
  assert.match(sender.messages[0] ?? "", /正在处理上一轮任务/);
});

test("/clear clears the default project session and does not resume old session", async () => {
  const backend = new FakeBackend();
  const sender = new FakeSender();
  const session = makeSession({ codexSessionId: "old-session", codexThreadId: "old-session" });
  const store = new FakeSessionStore();

  await handleMessageForTest(textMessage("user-1", "/clear"), account, session, store, sender, backend, 1);

  assert.equal(session.codexSessionId, undefined);
  assert.equal(session.codexThreadId, undefined);
  assert.equal(backend.resumeRequests.length, 0);
  assert.match(sender.messages.join("\n"), /项目 default 会话已清除/);
});

test("buildProjectBridgeRuntime wires registry-backed routing into BridgeService", async () => {
  const bridgeDir = await makeGitRepo("wcb-runtime-bridge-");
  const sageDir = await makeGitRepo("wcb-runtime-sage-");
  const sessionsDir = mkdtempSync(join(tmpdir(), "wcb-runtime-sessions-"));
  const backend = new FakeBackend({ text: "ok", interrupted: false, codexSessionId: "new-session" });
  const sender = new FakeSender();
  const config: BridgeConfig = {
    defaultCwd: bridgeDir,
    allowlistRoots: [bridgeDir, sageDir],
    extraWritableRoots: [sageDir],
    streamIntervalMs: 1,
    defaultProject: "bridge",
    projects: {
      bridge: { cwd: bridgeDir },
      SageTalk: { cwd: sageDir },
    },
  };

  try {
    const { bridgeService, projectManager } = await buildProjectBridgeRuntime({
      account,
      config,
      sender,
      backend,
      sessionStore: new ProjectSessionStore(sessionsDir),
    });

    await bridgeService.handleMessage(textMessage("user-1", "@SageTalk run tests"));

    assert.equal(projectManager.activeProjectAlias, "bridge");
    assert.equal(backend.startRequests.length, 1);
    assert.equal(backend.startRequests[0]?.cwd, sageDir);
    assert.equal(backend.startRequests[0]?.prompt, "run tests");
    assert.deepEqual(backend.startRequests[0]?.extraWritableRoots, [sageDir]);
  } finally {
    await rm(bridgeDir, { recursive: true, force: true });
    await rm(sageDir, { recursive: true, force: true });
    await rm(sessionsDir, { recursive: true, force: true });
  }
});

test("shutdownProjectBridgeRuntime stops monitor and interrupts all project runtimes", async () => {
  let stopped = false;
  let interrupted = false;
  let exitCode: number | undefined;

  await shutdownProjectBridgeRuntime(
    { stop: () => { stopped = true; } },
    { interruptAll: async () => { interrupted = true; } },
    (code) => {
      exitCode = code;
    },
  );

  assert.equal(stopped, true);
  assert.equal(interrupted, true);
  assert.equal(exitCode, 0);
});
