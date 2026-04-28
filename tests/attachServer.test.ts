import { existsSync, mkdtempSync } from "node:fs";
import { chmod, rm, stat } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMode } from "../src/backend/AgentBackend.js";
import { EventBus } from "../src/core/EventBus.js";
import { AttachServer, type AttachServerOptions } from "../src/ipc/AttachServer.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachServerEvent } from "../src/ipc/protocol.js";
import type { ProjectSession } from "../src/session/types.js";

interface FakeRunPromptOptions {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
  source?: string;
  onAccepted?: (projectAlias: string) => void;
}

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
  blockRunPrompt = false;
  blockSetModel = false;
  failRunPrompt = false;
  private releaseRunPrompt?: () => void;
  private releaseSetModel?: () => void;

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return ["bridge", "SageTalk"].map((alias) => ({
      alias,
      cwd: `/tmp/${alias}`,
      ready: true,
      active: alias === this.activeProjectAlias,
    }));
  }

  async setActiveProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    if (!["bridge", "SageTalk"].includes(alias)) throw new Error(`Unknown project: ${alias}`);
    this.activeProjectAlias = alias;
    return { alias, cwd: `/tmp/${alias}`, ready: true };
  }

  async runPrompt(options: FakeRunPromptOptions): Promise<void> {
    if (this.failRunPrompt) throw new Error("busy");
    this.prompts.push(stripPromptOptions(options));
    options.onAccepted?.(options.projectAlias ?? this.activeProjectAlias);
    if (this.blockRunPrompt) {
      await new Promise<void>((resolve) => {
        this.releaseRunPrompt = resolve;
      });
    }
  }

  unblockRunPrompt(): void {
    this.releaseRunPrompt?.();
  }

  async interrupt(alias?: string): Promise<void> {
    this.interrupts.push(alias);
  }

  async replacePrompt(options: FakeRunPromptOptions): Promise<void> {
    this.replacements.push(stripPromptOptions(options));
    options.onAccepted?.(options.projectAlias ?? this.activeProjectAlias);
    if (this.blockRunPrompt) {
      await new Promise<void>((resolve) => {
        this.releaseRunPrompt = resolve;
      });
    }
  }

  async setModel(alias: string | undefined, model: string | undefined): Promise<ProjectSession> {
    this.models.push({ alias, model });
    if (this.blockSetModel) {
      await new Promise<void>((resolve) => {
        this.releaseSetModel = resolve;
      });
    }
    return this.session(alias);
  }

  unblockSetModel(): void {
    this.releaseSetModel?.();
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

function stripPromptOptions(options: FakeRunPromptOptions): {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
  source?: string;
} {
  const { onAccepted: _onAccepted, ...promptOptions } = options;
  return promptOptions;
}

function makeSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wcb-attach-")), "bridge.sock");
}

function makeModelServiceStub(): AttachServerOptions["modelService"] {
  return {
    listModels: async () => ({ models: [] }),
    describeSession: async (session) => ({
      configuredModel: session.model,
      effectiveModel: session.model ?? "Codex CLI default",
      source: session.model ? "project override" : "unresolved",
    }),
  };
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
      describeSession: async (session) => ({
        configuredModel: session.model,
        effectiveModel: session.model ?? "Codex CLI default",
        source: session.model ? "project override" : "unresolved",
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

test("AttachServer applies requested hello project before reporting ready", async () => {
  await withServer(async ({ socketPath, manager }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", project: "SageTalk" }));
    const ready = await readNext(socket, buffer);
    socket.end();

    assert.equal(ready.type, "ready");
    assert.equal(ready.activeProject, "SageTalk");
    assert.equal(manager.activeProjectAlias, "SageTalk");
    assert.equal(ready.projects.find((project) => project.alias === "SageTalk")?.active, true);
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

test("AttachServer mirrors accepted prompts before the runtime turn completes", async () => {
  await withServer(async ({ socketPath, manager, wechatMessages }) => {
    manager.blockRunPrompt = true;
    const { socket } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "prompt", project: "bridge", text: "long task" }));
    await waitFor(() => manager.prompts.length === 1);

    assert.equal(wechatMessages.length, 1);
    assert.match(wechatMessages[0] ?? "", /long task/);

    manager.unblockRunPrompt();
    socket.end();
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

test("AttachServer reports model state for model commands without a value", async () => {
  await withServer(async ({ socketPath, manager }) => {
    await manager.setModel("bridge", "gpt-5.5");
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "model" }));
    const event = await readNext(socket, buffer);
    socket.end();

    assert.equal(event.type, "state");
    assert.equal(event.project, "bridge");
    assert.equal(event.model, "gpt-5.5");
    assert.equal(event.modelSource, "project override");
    assert.equal(manager.models.length, 1);
  });
});

test("AttachServer confirms model changes with updated model state", async () => {
  await withServer(async ({ socketPath, manager }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "model", value: "gpt-5.5" }));
    const event = await readNext(socket, buffer);
    socket.end();

    assert.equal(event.type, "state");
    assert.equal(event.project, "bridge");
    assert.equal(event.model, "gpt-5.5");
    assert.equal(event.modelSource, "project override");
    assert.deepEqual(manager.models, [{ alias: "bridge", model: "gpt-5.5" }]);
  });
});

test("AttachServer handles messages from one client in JSONL order", async () => {
  await withServer(async ({ socketPath, manager }) => {
    manager.blockSetModel = true;
    const { socket } = await connectClient(socketPath);

    socket.write(
      `${serializeAttachMessage({ type: "command", project: "bridge", name: "model", value: "gpt-5.5" })}${serializeAttachMessage({
        type: "prompt",
        project: "bridge",
        text: "after model",
      })}`,
    );
    await waitFor(() => manager.models.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(manager.prompts.length, 0);

    manager.unblockSetModel();
    await waitFor(() => manager.prompts.length === 1);
    socket.end();
  });
});

test("AttachServer continues processing commands after a prompt is accepted", async () => {
  await withServer(async ({ socketPath, manager, wechatMessages }) => {
    manager.blockRunPrompt = true;
    const { socket } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "prompt", project: "bridge", text: "long task" }));
    await waitFor(() => manager.prompts.length === 1 && wechatMessages.length === 1);

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "interrupt" }));
    await waitFor(() => manager.interrupts.length === 1);

    manager.unblockRunPrompt();
    socket.end();
  });
});

test("AttachServer continues processing commands after a replacement is accepted", async () => {
  await withServer(async ({ socketPath, manager, wechatMessages }) => {
    manager.blockRunPrompt = true;
    const { socket } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "replace", text: "long replacement" }));
    await waitFor(() => manager.replacements.length === 1 && wechatMessages.length === 1);
    assert.match(wechatMessages[0] ?? "", /桌面输入/);
    assert.match(wechatMessages[0] ?? "", /long replacement/);

    socket.write(serializeAttachMessage({ type: "command", project: "bridge", name: "interrupt" }));
    await waitFor(() => manager.interrupts.length === 1);

    manager.unblockRunPrompt();
    socket.end();
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

    first.socket.write(serializeAttachMessage({ type: "command", name: "project" }));
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

test("AttachServer switches active project before reporting ready", async () => {
  await withServer(async ({ socketPath, manager }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli" }));
    assert.equal((await readNext(socket, buffer)).type, "ready");

    socket.write(serializeAttachMessage({ type: "command", name: "project", value: "SageTalk" }));
    const ready = await readNext(socket, buffer);
    socket.end();

    assert.equal(ready.type, "ready");
    assert.equal(ready.activeProject, "SageTalk");
    assert.equal(manager.activeProjectAlias, "SageTalk");
    assert.equal(ready.projects.find((project) => project.alias === "SageTalk")?.active, true);
  });
});

test("AttachServer reports project switch errors and returns current ready state", async () => {
  await withServer(async ({ socketPath, manager }) => {
    const { socket, buffer } = await connectClient(socketPath);

    socket.write(serializeAttachMessage({ type: "command", name: "project", value: "missing" }));
    const error = await readNext(socket, buffer);
    const ready = await readNext(socket, buffer);
    socket.end();

    assert.equal(error.type, "error");
    assert.match(error.message, /Unknown project: missing/);
    assert.equal(ready.type, "ready");
    assert.equal(ready.activeProject, "bridge");
    assert.equal(manager.activeProjectAlias, "bridge");
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
    modelService: makeModelServiceStub(),
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
    modelService: makeModelServiceStub(),
  });

  await attachServer.stop();
  assert.equal(existsSync(socketPath), true);

  await closeServer(liveServer);
  await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
});

test("AttachServer restricts attach directory and socket permissions", async () => {
  const socketPath = makeSocketPath();
  const socketDir = dirname(socketPath);
  await chmod(socketDir, 0o777);
  const attachServer = new AttachServer({
    socketPath,
    eventBus: new EventBus(),
    projectManager: new FakeProjectManager(),
    boundUserId: "user-1",
    sendWechatText: async () => undefined,
    modelService: makeModelServiceStub(),
  });

  try {
    await attachServer.start();

    assert.equal((await stat(socketDir)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  } finally {
    await attachServer.stop();
    await rm(socketDir, { recursive: true, force: true });
  }
});

test("AttachServer disconnects clients whose accumulated socket buffer exceeds the output limit", () => {
  const attachServer = new AttachServer({
    socketPath: makeSocketPath(),
    eventBus: new EventBus(),
    projectManager: new FakeProjectManager(),
    boundUserId: "user-1",
    sendWechatText: async () => undefined,
    modelService: makeModelServiceStub(),
  });
  let wrote = false;
  let destroyed = false;
  const socket = {
    destroyed: false,
    writableLength: 1024 * 1024 - 1,
    write: () => {
      wrote = true;
      return true;
    },
    destroy: () => {
      destroyed = true;
      return socket as unknown as Socket;
    },
  };

  (
    attachServer as unknown as {
      send: (socket: Socket, event: AttachServerEvent) => void;
    }
  ).send(socket as unknown as Socket, { type: "error", message: "buffer limit" });

  assert.equal(wrote, false);
  assert.equal(destroyed, true);
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
