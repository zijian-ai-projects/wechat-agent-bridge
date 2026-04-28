import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMode } from "../src/backend/AgentBackend.js";
import { EventBus } from "../src/core/EventBus.js";
import { AttachServer } from "../src/ipc/AttachServer.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachServerEvent } from "../src/ipc/protocol.js";
import type { ProjectSession } from "../src/session/types.js";

class FakeProjectManager {
  activeProjectAlias = "bridge";
  prompts: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }> = [];
  interrupts: Array<string | undefined> = [];
  replacements: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }> = [];
  models: Array<{ alias?: string; model?: string }> = [];

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }];
  }

  async runPrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string; source?: string }): Promise<void> {
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
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve({ socket, buffer }));
    socket.once("error", reject);
  });
}

async function readNext(socket: Socket, buffer: JsonLineBuffer<AttachServerEvent>): Promise<AttachServerEvent> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", onData);
      socket.off("error", reject);
      reject(new Error("Timed out waiting for attach server event"));
    }, 1000);
    const onData = (chunk: Buffer) => {
      try {
        const events = buffer.push(chunk.toString("utf8"));
        if (events.length > 0) {
          clearTimeout(timer);
          socket.off("data", onData);
          socket.off("error", reject);
          resolve(events[0]);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", reject);
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
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
    const models = await readNext(socket, buffer);
    socket.end();

    assert.deepEqual(manager.interrupts, ["bridge"]);
    assert.equal(manager.replacements[0]?.prompt, "retry");
    assert.equal(manager.replacements[0]?.source, "attach");
    assert.deepEqual(manager.models, [{ alias: "bridge", model: "gpt-5.5" }]);
    assert.equal(models.type, "models");
    assert.equal(models.models[0]?.slug, "gpt-5.5");
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}
