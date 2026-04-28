import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMode } from "../src/backend/AgentBackend.js";
import { EventBus } from "../src/core/EventBus.js";
import { AttachServer } from "../src/ipc/AttachServer.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachServerEvent } from "../src/ipc/protocol.js";
import type { ProjectSession } from "../src/session/types.js";

interface ClientReadWaiter {
  reject: (error: Error) => void;
  resolve: (event: AttachServerEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientReadState {
  buffer: JsonLineBuffer<AttachServerEvent>;
  closedError?: Error;
  events: AttachServerEvent[];
  waiters: ClientReadWaiter[];
}

const clientReadStates = new WeakMap<Socket, ClientReadState>();

class FakeProjectManager {
  activeProjectAlias = "bridge";
  prompts: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }> = [];
  interrupts: Array<string | undefined> = [];
  replacements: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }> = [];
  models: Array<{ alias?: string; model?: string }> = [];
  failRunPrompt = false;

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }];
  }

  async runPrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }): Promise<void> {
    if (this.failRunPrompt) throw new Error("busy");
    this.prompts.push(options);
  }

  async interrupt(alias?: string): Promise<void> {
    this.interrupts.push(alias);
  }

  async replacePrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }): Promise<void> {
    this.replacements.push(options);
  }

  async setModel(alias: string | undefined, model: string | undefined): Promise<ProjectSession> {
    this.models.push({ alias, model });
    return this.session(alias);
  }

  async session(alias = "bridge"): Promise<ProjectSession> {
    return {
      userId: "user-1",
      projectAlias: alias,
      state: "idle",
      cwd: "/tmp/bridge",
      mode: "readonly" as AgentMode,
      model: this.models.at(-1)?.model,
      history: [],
      allowlistRoots: ["/tmp/bridge"],
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
  }
}

function makeSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wcb-attach-")), "bridge.sock");
}

function connectClient(socketPath: string): Promise<{ socket: Socket; buffer: JsonLineBuffer<AttachServerEvent> }> {
  const socket = connect(socketPath);
  const buffer = new JsonLineBuffer<AttachServerEvent>();
  const state: ClientReadState = { buffer, events: [], waiters: [] };
  clientReadStates.set(socket, state);
  socket.on("data", (chunk: Buffer) => {
    try {
      enqueueClientEvents(state, buffer.push(chunk.toString("utf8")));
    } catch (error) {
      failClientReads(state, error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("close", () => {
    failClientReads(state, new Error("Attach client socket closed before an event was received"));
  });
  socket.on("error", (error) => {
    failClientReads(state, error);
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve({ socket, buffer }));
    socket.once("error", reject);
  });
}

async function readNext(socket: Socket, buffer: JsonLineBuffer<AttachServerEvent>): Promise<AttachServerEvent> {
  const state = clientReadStates.get(socket);
  if (!state || state.buffer !== buffer) throw new Error("Unknown attach test client");
  const queuedEvent = state.events.shift();
  if (queuedEvent) return queuedEvent;
  if (state.closedError) throw state.closedError;
  return await new Promise((resolve, reject) => {
    const waiter: ClientReadWaiter = {
      reject,
      resolve,
      timer: setTimeout(() => {
        state.waiters = state.waiters.filter((pending) => pending !== waiter);
        reject(new Error("Timed out waiting for attach server event"));
      }, 5000),
    };
    state.waiters.push(waiter);
  });
}

async function readUntil(
  socket: Socket,
  buffer: JsonLineBuffer<AttachServerEvent>,
  predicate: (event: AttachServerEvent) => boolean,
): Promise<AttachServerEvent> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = await readNext(socket, buffer);
    if (predicate(event)) return event;
  }
  assert.fail("Timed out waiting for matching attach server event");
}

function enqueueClientEvents(state: ClientReadState, events: AttachServerEvent[]): void {
  for (const event of events) {
    const waiter = state.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      continue;
    }
    state.events.push(event);
  }
}

function failClientReads(state: ClientReadState, error: Error): void {
  state.closedError = error;
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

async function withServer(
  callback: (fixture: {
    socketPath: string;
    eventBus: EventBus;
    manager: FakeProjectManager;
    server: AttachServer;
    wechatMessages: string[];
  }) => Promise<void>,
): Promise<void> {
  const socketPath = makeSocketPath();
  const eventBus = new EventBus();
  const manager = new FakeProjectManager();
  const wechatMessages: string[] = [];
  const server = new AttachServer({
    socketPath,
    eventBus,
    projectManager: manager,
    boundUserId: "user-1",
    sendWechatText: async (text) => {
      wechatMessages.push(text);
    },
    modelService: {
      listModels: async () => ({
        models: [{ slug: "gpt-5.5", displayName: "GPT-5.5" }],
      }),
    },
  });
  await server.start();
  try {
    await callback({ socketPath, eventBus, manager, server, wechatMessages });
  } finally {
    await server.stop();
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
}

test("AttachServer sends ready on hello and dispatches prompts", async () => {
  await withServer(async ({ socketPath, manager, wechatMessages }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", project: "bridge" }));
    const ready = await readNext(socket, buffer);
    assert.equal(ready.type, "ready");
    assert.equal(ready.activeProject, "bridge");
    assert.equal(ready.projects[0]?.alias, "bridge");

    socket.write(serializeAttachMessage({ type: "prompt", project: "bridge", text: "hi" }));
    await waitFor(() => manager.prompts.length === 1);
    socket.end();

    assert.equal(manager.prompts[0]?.prompt, "hi");
    assert.equal(manager.prompts[0]?.source, "attach");
    assert.match(wechatMessages[0] ?? "", /桌面输入/);
    assert.match(wechatMessages[0] ?? "", /hi/);
  });
});

test("AttachServer mirrors prompts only after runtime accepts them", async () => {
  await withServer(async ({ socketPath, manager, wechatMessages }) => {
    manager.failRunPrompt = true;
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "prompt", project: "bridge", text: "busy prompt" }));
    const event = await readNext(socket, buffer);
    socket.end();

    assert.equal(event.type, "error");
    assert.match(event.message, /busy/);
    assert.equal(wechatMessages.length, 0);
  });
});

test("AttachServer broadcasts bridge events and handles commands", async () => {
  await withServer(async ({ socketPath, eventBus, manager }) => {
    const { socket, buffer } = await connectClient(socketPath);
    socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", project: "bridge" }));
    assert.equal((await readNext(socket, buffer)).type, "ready");

    await eventBus.publish({ type: "codex_event", project: "bridge", text: "progress", timestamp: "2026-04-27T00:00:00.000Z" });
    const event = await readNext(socket, buffer);
    assert.equal(event.type, "codex_event");
    assert.equal(event.text, "progress");

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "interrupt" }));
    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "replace", text: "retry" }));
    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "model", value: "gpt-5.5" }));
    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "models" }));
    await waitFor(() => manager.interrupts.length === 1 && manager.replacements.length === 1 && manager.models.length === 1);
    const models = await readUntil(socket, buffer, (event) => event.type === "models");
    socket.end();

    assert.deepEqual(manager.interrupts, ["bridge"]);
    assert.equal(manager.replacements[0]?.prompt, "retry");
    assert.equal(manager.replacements[0]?.source, "attach");
    assert.deepEqual(manager.models, [{ alias: "bridge", model: "gpt-5.5" }]);
    assert.equal(models.type, "models");
    assert.equal(models.models[0]?.slug, "gpt-5.5");
  });
});

test("AttachServer returns truthful project status and broadcasts to multiple clients", async () => {
  await withServer(async ({ socketPath, eventBus }) => {
    const first = await connectClient(socketPath);
    const second = await connectClient(socketPath);
    first.socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli" }));
    second.socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli" }));
    await readNext(first.socket, first.buffer);
    await readNext(second.socket, second.buffer);

    first.socket.write(serializeAttachMessage({ type: "command", name: "project", value: "missing" }));
    const ready = await readNext(first.socket, first.buffer);
    assert.equal(ready.type, "ready");
    assert.equal(ready.activeProject, "bridge");
    assert.equal(ready.projects[0]?.active, true);

    await eventBus.publish({ type: "codex_event", project: "bridge", text: "fanout", timestamp: "2026-04-27T00:00:00.000Z" });
    const firstEvent = await readNext(first.socket, first.buffer);
    const secondEvent = await readNext(second.socket, second.buffer);
    first.socket.end();
    second.socket.end();

    assert.equal(firstEvent.type, "codex_event");
    assert.equal(secondEvent.type, "codex_event");
  });
});

test("AttachServer reports invalid client JSON as an error event", async () => {
  await withServer(async ({ socketPath }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write("{bad}\n");
    const event = await readNext(socket, buffer);
    socket.end();

    assert.equal(event.type, "error");
    assert.match(event.message, /Invalid JSONL message/);
  });
});

test("AttachServer drains valid JSON preserved after an invalid line", async () => {
  await withServer(async ({ socketPath }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(`{bad}\n${serializeAttachMessage({ type: "hello", client: "attach-cli" })}`);
    const error = await readNext(socket, buffer);
    const ready = await readNext(socket, buffer);
    socket.end();

    assert.equal(error.type, "error");
    assert.equal(ready.type, "ready");
  });
});

test("AttachServer does not interrupt work when a client disconnects", async () => {
  await withServer(async ({ socketPath, manager }) => {
    const { socket } = await connectClient(socketPath);

    socket.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(manager.interrupts, []);
  });
});

test("AttachServer refuses to unlink a live socket owned by another server", async () => {
  const socketPath = makeSocketPath();
  const liveServer = await listen(socketPath);
  const attachServer = new AttachServer({
    socketPath,
    eventBus: new EventBus(),
    projectManager: new FakeProjectManager(),
    boundUserId: "user-1",
    sendWechatText: async () => undefined,
    modelService: { listModels: async () => ({ models: [] }) },
  });
  let started = false;

  try {
    await assert.rejects(
      async () => {
        await attachServer.start();
        started = true;
      },
      /Attach socket is already in use/,
    );
  } finally {
    if (started) await attachServer.stop();
    await closeServer(liveServer);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("AttachServer stop before start is safe and does not remove unrelated sockets", async () => {
  const socketPath = makeSocketPath();
  const liveServer = await listen(socketPath);
  const attachServer = new AttachServer({
    socketPath,
    eventBus: new EventBus(),
    projectManager: new FakeProjectManager(),
    boundUserId: "user-1",
    sendWechatText: async () => undefined,
    modelService: { listModels: async () => ({ models: [] }) },
  });

  await attachServer.stop();
  assert.equal(existsSync(socketPath), true);

  await closeServer(liveServer);
  await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
});

async function listen(socketPath: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}
