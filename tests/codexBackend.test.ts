import test from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "node:events";

import { buildCodexExecArgs, formatCodexEventForWechat, interruptChildProcess } from "../src/backend/CodexExecBackend.js";
import { parseJsonLine } from "../src/backend/codexEvents.js";

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
