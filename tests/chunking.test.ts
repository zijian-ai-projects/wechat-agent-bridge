import test from "node:test";
import assert from "node:assert/strict";

import { splitWechatMessage } from "../src/runtime/chunking.js";

test("splitWechatMessage keeps every chunk under the max length", () => {
  const text = "x".repeat(4500);
  const chunks = splitWechatMessage(text, 1024);

  assert.equal(chunks.length, 5);
  assert.ok(chunks.every((chunk) => chunk.length <= 1024));
  assert.equal(chunks.join(""), text);
});

test("splitWechatMessage prefers newline boundaries near the limit", () => {
  const text = `${"a".repeat(40)}\n${"b".repeat(20)}\n${"c".repeat(20)}`;
  const chunks = splitWechatMessage(text, 64);

  assert.deepEqual(chunks, [`${"a".repeat(40)}\n${"b".repeat(20)}`, `${"c".repeat(20)}`]);
});
