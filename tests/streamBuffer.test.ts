import test from "node:test";
import assert from "node:assert/strict";

import { StreamBuffer } from "../src/runtime/streamBuffer.js";

test("StreamBuffer sends the first progress update immediately", async () => {
  const sent: string[] = [];
  const buffer = new StreamBuffer({
    intervalMs: 60_000,
    send: async (text) => {
      sent.push(text);
    },
  });

  await buffer.append("Codex 开始处理");

  assert.deepEqual(sent, ["Codex 开始处理"]);
});
