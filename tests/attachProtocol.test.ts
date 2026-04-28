import test from "node:test";
import assert from "node:assert/strict";

import { parseAttachInput } from "../src/ipc/attachCommands.js";
import { JsonLineBuffer, serializeAttachEvent, serializeAttachMessage } from "../src/ipc/protocol.js";

test("JsonLineBuffer emits complete JSON lines", () => {
  const buffer = new JsonLineBuffer();

  assert.deepEqual(buffer.push('{"type":"hello"'), []);
  assert.deepEqual(buffer.push('}\n{"type":"status"}\n'), [{ type: "hello" }, { type: "status" }]);
});

test("JsonLineBuffer reports invalid JSON lines as errors", () => {
  const buffer = new JsonLineBuffer();

  assert.throws(() => buffer.push("{bad}\n"), /Invalid JSONL message/);
});

test("serializeAttachEvent writes one JSON object per line", () => {
  assert.equal(serializeAttachEvent({ type: "error", message: "boom" }), '{"type":"error","message":"boom"}\n');
});

test("serializeAttachMessage writes one JSON object per line", () => {
  assert.equal(
    serializeAttachMessage({ type: "prompt", project: "bridge", text: "fix tests" }),
    '{"type":"prompt","project":"bridge","text":"fix tests"}\n',
  );
});

test("parseAttachInput maps plain text and colon commands", () => {
  assert.deepEqual(parseAttachInput("fix tests", "bridge"), { type: "prompt", project: "bridge", text: "fix tests" });
  assert.deepEqual(parseAttachInput(":interrupt", "bridge"), { type: "command", project: "bridge", name: "interrupt" });
  assert.deepEqual(parseAttachInput(":replace retry this", "bridge"), {
    type: "command",
    project: "bridge",
    name: "replace",
    text: "retry this",
  });
  assert.deepEqual(parseAttachInput(":model gpt-5.5", "bridge"), {
    type: "command",
    project: "bridge",
    name: "model",
    value: "gpt-5.5",
  });
  assert.deepEqual(parseAttachInput(":models", "bridge"), { type: "command", project: "bridge", name: "models" });
  assert.deepEqual(parseAttachInput(":status", "bridge"), { type: "command", project: "bridge", name: "status" });
});

test("parseAttachInput preserves prompt whitespace but ignores empty input", () => {
  assert.equal(parseAttachInput("   "), undefined);
  assert.deepEqual(parseAttachInput("  keep leading spaces", "bridge"), {
    type: "prompt",
    project: "bridge",
    text: "  keep leading spaces",
  });
});

test("parseAttachInput ignores unknown colon commands", () => {
  assert.equal(parseAttachInput(":unknown", "bridge"), undefined);
});
