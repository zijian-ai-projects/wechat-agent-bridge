import test from "node:test";
import assert from "node:assert/strict";

import { AgentService } from "../src/core/AgentService.js";
import { BridgeMcpContext, callBridgeTool, listBridgeTools } from "../src/mcp/tools/index.js";
import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import type { AccountData } from "../src/config/accounts.js";
import type { BridgeSession } from "../src/session/types.js";
import type { WechatRuntimeStatus } from "../src/core/types.js";

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resumeRequests: AgentTurnRequest[] = [];

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    return { text: "started", interrupted: false, codexSessionId: "new-session" };
  }

  async resumeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.resumeRequests.push(request);
    return { text: "resumed", interrupted: false, codexSessionId: request.codexSessionId };
  }

  async interrupt(userId: string): Promise<void> {
    this.interrupts.push(userId);
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
    history: [{ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
    allowlistRoots: ["/tmp/repo"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeContext(session = makeSession(), backend = new FakeBackend()): BridgeMcpContext & { backend: FakeBackend; store: MemorySessionStore } {
  const store = new MemorySessionStore();
  return {
    account,
    session,
    sessionStore: store,
    agentService: new AgentService(backend),
    backend,
    store,
  };
}

test("MCP tools expose stable tool names", () => {
  assert.deepEqual(
    listBridgeTools().map((tool) => tool.name).sort(),
    [
      "agent_interrupt",
      "agent_resume",
      "agent_set_cwd",
      "agent_set_mode",
      "session_clear",
      "wechat_bind_status",
      "wechat_history",
      "wechat_status",
    ],
  );
});

test("wechat_status and wechat_history return machine-readable data", async () => {
  const context = makeContext();

  const status = await callBridgeTool(context, "wechat_status", {});
  assert.equal(status.ok, true);
  if (!status.ok) throw new Error("wechat_status failed");
  const statusData = status.data as WechatRuntimeStatus;
  assert.equal(statusData.boundUserId, "user-1");
  assert.equal(statusData.session.state, "idle");

  const history = await callBridgeTool(context, "wechat_history", { limit: 5 });
  assert.equal(history.ok, true);
  if (!history.ok) throw new Error("wechat_history failed");
  assert.equal((history.data as { text: string }).text, "1");
});

test("session_clear and agent_interrupt call core services", async () => {
  const context = makeContext();

  const cleared = await callBridgeTool(context, "session_clear", {});
  assert.equal(cleared.ok, true);
  assert.ok(context.session);
  assert.equal(context.session.codexSessionId, undefined);

  const interrupted = await callBridgeTool(context, "agent_interrupt", {});
  assert.equal(interrupted.ok, true);
  assert.deepEqual(context.backend.interrupts, ["user-1", "user-1"]);
});

test("agent_resume calls resume with existing session id and saves assistant history", async () => {
  const context = makeContext();

  const result = await callBridgeTool(context, "agent_resume", { prompt: "continue" });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("agent_resume failed");
  assert.equal((result.data as { text: string }).text, "resumed");
  assert.equal(context.backend.resumeRequests.length, 1);
  assert.ok(context.session);
  assert.equal(context.session.history.at(-1)?.content, "resumed");
});

test("agent_set_mode validates input and returns standardized MCP errors", async () => {
  const context = makeContext();

  const invalid = await callBridgeTool(context, "agent_set_mode", { mode: "auto" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "INVALID_ARGUMENT");

  const valid = await callBridgeTool(context, "agent_set_mode", { mode: "workspace" });
  assert.equal(valid.ok, true);
  assert.ok(context.session);
  assert.equal(context.session.mode, "workspace");
});

test("unknown MCP tool returns a standardized error", async () => {
  const context = makeContext();

  const result = await callBridgeTool(context, "missing_tool", {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNKNOWN_TOOL");
});
