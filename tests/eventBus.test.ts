import test from "node:test";
import assert from "node:assert/strict";

import { EventBus, type BridgeEvent } from "../src/core/EventBus.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

function stateEvent(): BridgeEvent {
  return {
    type: "state",
    project: "bridge",
    state: "idle",
    model: "Codex CLI default",
    modelSource: "unresolved",
    timestamp: "2026-04-27T00:00:00.000Z",
  };
}

function codexEvent(text: string): BridgeEvent {
  return {
    type: "codex_event",
    project: "bridge",
    text,
    timestamp: "2026-04-27T00:00:00.000Z",
  };
}

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

  await waitFor(() => received.length === 1);
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

  await waitFor(() => received.length === 1);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "state");
});

test("EventBus publish does not wait for slow subscribers", async () => {
  const bus = new EventBus();
  let fastSubscriberCalled = false;
  bus.subscribe(async () => {
    await new Promise(() => undefined);
  });
  bus.subscribe(() => {
    fastSubscriberCalled = true;
  });

  const result = await Promise.race([bus.publish(stateEvent()).then(() => "published"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 20))]);

  assert.equal(result, "published");
  await waitFor(() => fastSubscriberCalled);
});

test("EventBus drops events beyond the subscriber queue limit", async () => {
  const bus = new EventBus({ maxQueuedEventsPerSubscriber: 1 });
  let received = 0;
  let release: (() => void) | undefined;
  bus.subscribe(async () => {
    received += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  await bus.publish(codexEvent("first"));
  await bus.publish(codexEvent("dropped"));
  await waitFor(() => received === 1);
  release?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(received, 1);
});

test("EventBus keeps terminal events when progress events overflow", async () => {
  const bus = new EventBus({ maxQueuedEventsPerSubscriber: 1 });
  const received: string[] = [];
  let release: (() => void) | undefined;
  bus.subscribe(async (event) => {
    received.push(event.type === "codex_event" ? event.text : event.type);
    if (received.length === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  });

  await bus.publish(codexEvent("first"));
  await bus.publish(codexEvent("dropped"));
  await bus.publish(stateEvent());
  await waitFor(() => received.length === 1);
  release?.();
  await waitFor(() => received.length === 2);

  assert.deepEqual(received, ["first", "state"]);
});
