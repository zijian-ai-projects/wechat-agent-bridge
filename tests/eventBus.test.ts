import test from "node:test";
import assert from "node:assert/strict";

import { EventBus, type BridgeEvent } from "../src/core/EventBus.js";

test("EventBus publishes events to active subscribers", async () => {
  const bus = new EventBus();
  const received: BridgeEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    received.push(event);
  });

  await bus.publish({
    type: "user_message",
    source: "wechat",
    project: "bridge",
    text: "hi",
    timestamp: "2026-04-27T00:00:00.000Z",
  });
  unsubscribe();
  await bus.publish({
    type: "user_message",
    source: "attach",
    project: "bridge",
    text: "ignored",
    timestamp: "2026-04-27T00:00:01.000Z",
  });

  assert.deepEqual(
    received.map((event) => event.type),
    ["user_message"],
  );
  const [event] = received;
  assert.equal(event?.type, "user_message");
  if (event?.type !== "user_message") {
    assert.fail("expected user_message event");
  }
  assert.equal(event.source, "wechat");
  assert.equal(event.project, "bridge");
});

test("EventBus isolates subscriber failures", async () => {
  const bus = new EventBus();
  const received: BridgeEvent[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((event) => {
    received.push(event);
  });

  await bus.publish({
    type: "state",
    project: "bridge",
    state: "idle",
    model: "Codex CLI default",
    modelSource: "unresolved",
    timestamp: "2026-04-27T00:00:00.000Z",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "state");
});
