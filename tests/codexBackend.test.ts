import test from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBackendCapabilities } from "../src/backend/capabilities.js";
import { buildCodexExecArgs, CodexExecBackend, formatCodexEventForWechat, interruptChildProcess } from "../src/backend/CodexExecBackend.js";
import { parseJsonLine } from "../src/backend/codexEvents.js";

async function createFakeCodex(prefix: string): Promise<{ dir: string; bin: string }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, "fake-codex.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
setTimeout(() => process.exit(2), 5000);
`,
    { mode: 0o700 },
  );
  await chmod(bin, 0o700);
  return { dir, bin };
}

test("buildCodexExecArgs maps modes to Codex sandbox flags", () => {
  assert.deepEqual(
    buildCodexExecArgs({ prompt: "hi", cwd: "/tmp/project", mode: "readonly" }),
    ["--sandbox", "read-only", "--ask-for-approval", "never", "--cd", "/tmp/project", "exec", "--json", "hi"],
  );

  assert.deepEqual(
    buildCodexExecArgs({ prompt: "hi", cwd: "/tmp/project", mode: "workspace", model: "gpt-5.4", extraWritableRoots: ["/tmp/SageTalk"] }),
    [
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--cd",
      "/tmp/project",
      "--add-dir",
      "/tmp/SageTalk",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "hi",
    ],
  );

  assert.deepEqual(
    buildCodexExecArgs({ prompt: "hi", cwd: "/tmp/project", mode: "yolo" }),
    ["--dangerously-bypass-approvals-and-sandbox", "--cd", "/tmp/project", "exec", "--json", "hi"],
  );
});

test("buildCodexExecArgs prefers codex exec resume when session id exists", () => {
  assert.deepEqual(
    buildCodexExecArgs({ prompt: "next", cwd: "/tmp/project", mode: "readonly", codexSessionId: "abc-123" }),
    ["--sandbox", "read-only", "--ask-for-approval", "never", "--cd", "/tmp/project", "exec", "resume", "--json", "abc-123", "next"],
  );
});

test("AgentTurnRequest can carry a per-project execution key", () => {
  const request = {
    userId: "user-1",
    executionKey: "user-1:SageTalk",
    prompt: "hi",
    cwd: "/tmp/SageTalk",
    mode: "readonly" as const,
  };

  assert.equal(request.executionKey, "user-1:SageTalk");
  assert.deepEqual(
    buildCodexExecArgs(request),
    ["--sandbox", "read-only", "--ask-for-approval", "never", "--cd", "/tmp/SageTalk", "exec", "--json", "hi"],
  );
});

test("CodexExecBackend interrupts a project turn by execution key", async () => {
  const { dir, bin } = await createFakeCodex("wcb-codex-exec-key-");
  const backend = new CodexExecBackend(bin);
  let started = false;

  const turn = backend.startTurn(
    {
      userId: "user-1",
      executionKey: "user-1:SageTalk",
      prompt: "hi",
      cwd: dir,
      mode: "readonly",
    },
    {
      onEvent: (event) => {
        if ((event as { type?: string }).type === "turn.started") started = true;
      },
    },
  );

  await waitFor(() => started);
  await backend.interrupt("user-1:SageTalk");

  const result = await turn;

  assert.equal(result.interrupted, true);
});

test("CodexExecBackend falls back to user id for legacy interrupts", async () => {
  const { dir, bin } = await createFakeCodex("wcb-codex-legacy-");
  const backend = new CodexExecBackend(bin);
  let started = false;

  const turn = backend.startTurn(
    {
      userId: "user-1",
      prompt: "hi",
      cwd: dir,
      mode: "readonly",
    },
    {
      onEvent: (event) => {
        if ((event as { type?: string }).type === "turn.started") started = true;
      },
    },
  );

  await waitFor(() => started);
  await backend.interrupt("user-1");

  const result = await turn;

  assert.equal(result.interrupted, true);
});

test("formatCodexEventForWechat summarizes key JSONL events", () => {
  assert.equal(
    formatCodexEventForWechat({ type: "thread.started", thread_id: "thread-1" }),
    "Codex 线程已开始: thread-1",
  );
  assert.match(
    formatCodexEventForWechat({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0 } }) ?? "",
    /命令完成.*npm test.*0/s,
  );
  assert.match(
    formatCodexEventForWechat({ type: "turn.failed", error: { message: "boom" } }) ?? "",
    /失败.*boom/s,
  );
});

test("unknown JSONL events are ignored without throwing", () => {
  assert.doesNotThrow(() => formatCodexEventForWechat({ type: "future.event", payload: { ok: true } }));
  assert.equal(formatCodexEventForWechat({ type: "future.event", payload: { ok: true } }), undefined);
});

test("transient reconnect errors are not sent to WeChat as Codex failures", () => {
  assert.equal(
    formatCodexEventForWechat({ type: "error", message: "Reconnecting... 5/5 (timeout waiting for child process to exit)" }),
    undefined,
  );
});

test("stdout JSONL parser does not parse stderr log text", () => {
  assert.deepEqual(parseJsonLine('{"type":"turn.started"}'), { type: "turn.started" });
  assert.equal(parseJsonLine("codex progress: still thinking", { source: "stderr" }), undefined);
});

test("interruptChildProcess sends SIGINT before hard kill", async () => {
  const signals: string[] = [];
  const child = new EventEmitter() as EventEmitter & { kill: (signal?: NodeJS.Signals | number) => boolean };
  child.kill = (signal?: NodeJS.Signals | number) => {
    signals.push(String(signal));
    if (signal === "SIGINT") queueMicrotask(() => child.emit("close"));
    return true;
  };

  await interruptChildProcess(child, 50);

  assert.deepEqual(signals, ["SIGINT"]);
});

test("backend capabilities mark Codex as the only runnable v1 backend", () => {
  assert.equal(getBackendCapabilities("codex").available, true);
  assert.equal(getBackendCapabilities("codex").supportsResume, true);
  assert.equal(getBackendCapabilities("claude").available, false);
  assert.equal(getBackendCapabilities("cursor").available, false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fake codex to start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
