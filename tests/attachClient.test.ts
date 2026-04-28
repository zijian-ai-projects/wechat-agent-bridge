import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";

import { renderAttachEvent, runAttach } from "../src/ipc/AttachClient.js";
import { JsonLineBuffer, parseAttachClientMessage, serializeAttachEvent, type AttachClientMessage } from "../src/ipc/protocol.js";

test("renderAttachEvent formats ready and runtime events", () => {
  assert.match(
    renderAttachEvent({
      type: "ready",
      activeProject: "bridge",
      projects: [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }],
    }),
    /active project: bridge/,
  );
  assert.match(
    renderAttachEvent({
      type: "turn_started",
      source: "wechat",
      project: "bridge",
      model: "gpt-5.5",
      modelSource: "project override",
      mode: "workspace",
      timestamp: "2026-04-27T00:00:00.000Z",
    }),
    /model: gpt-5.5/,
  );
  assert.match(
    renderAttachEvent({
      type: "codex_event",
      project: "bridge",
      text: "命令开始: npm test",
      timestamp: "2026-04-27T00:00:00.000Z",
    }),
    /\[bridge\] 命令开始: npm test/,
  );
});

test("runAttach connects, prints ready state, and forwards terminal input", async () => {
  const socketPath = makeSocketPath();
  const received: AttachClientMessage[] = [];
  let clientSocket: Socket | undefined;
  const server = createServer((socket) => {
    clientSocket = socket;
    const buffer = new JsonLineBuffer<AttachClientMessage>({ parse: parseAttachClientMessage });
    socket.on("data", (chunk: Buffer) => {
      received.push(...buffer.push(chunk.toString("utf8")));
    });
  });
  const stdin = new PassThrough();
  const stdout = captureOutput();
  await listen(server, socketPath);

  try {
    const run = runAttach({ socketPath, stdin, stdout: stdout.stream, project: "bridge" });
    await waitFor(() => received.some((message) => message.type === "hello"));
    clientSocket?.write(
      serializeAttachEvent({
        type: "ready",
        activeProject: "bridge",
        projects: [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }],
      }),
    );
    await waitFor(() => stdout.text().includes("active project: bridge"));

    stdin.write("hello from desktop\n");
    stdin.write(":models\n");
    await waitFor(() => received.length === 3);
    clientSocket?.end();
    await run;

    assert.deepEqual(received, [
      { type: "hello", client: "attach-cli", project: "bridge" },
      { type: "prompt", project: "bridge", text: "hello from desktop" },
      { type: "command", project: "bridge", name: "models" },
    ]);
    assert.match(stdout.text(), /connected to wechat-agent-bridge/);
  } finally {
    clientSocket?.destroy();
    stdin.destroy();
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach buffers terminal input until ready establishes the active project", async () => {
  const socketPath = makeSocketPath();
  const received: AttachClientMessage[] = [];
  let clientSocket: Socket | undefined;
  const server = createServer((socket) => {
    clientSocket = socket;
    const buffer = new JsonLineBuffer<AttachClientMessage>({ parse: parseAttachClientMessage });
    socket.on("data", (chunk: Buffer) => {
      received.push(...buffer.push(chunk.toString("utf8")));
    });
  });
  const stdin = new PassThrough();
  const stdout = captureOutput();
  await listen(server, socketPath);

  try {
    const run = runAttach({ socketPath, stdin, stdout: stdout.stream });
    stdin.write("queued prompt\n");
    stdin.end();
    await waitFor(() => received.some((message) => message.type === "hello"));
    assert.equal(received.length, 1);

    clientSocket?.write(
      serializeAttachEvent({
        type: "ready",
        activeProject: "SageTalk",
        projects: [{ alias: "SageTalk", cwd: "/tmp/sage", ready: true, active: true }],
      }),
    );
    await waitFor(() => received.length === 2);
    clientSocket?.end();
    await run;

    assert.deepEqual(received[1], { type: "prompt", project: "SageTalk", text: "queued prompt" });
  } finally {
    stdin.destroy();
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach waits for project switch ready before sending following prompts", async () => {
  const socketPath = makeSocketPath();
  const received: AttachClientMessage[] = [];
  let clientSocket: Socket | undefined;
  const server = createServer((socket) => {
    clientSocket = socket;
    const buffer = new JsonLineBuffer<AttachClientMessage>({ parse: parseAttachClientMessage });
    socket.on("data", (chunk: Buffer) => {
      received.push(...buffer.push(chunk.toString("utf8")));
    });
  });
  const stdin = new PassThrough();
  const stdout = captureOutput();
  await listen(server, socketPath);

  try {
    const run = runAttach({ socketPath, stdin, stdout: stdout.stream });
    await waitFor(() => received.some((message) => message.type === "hello"));
    clientSocket?.write(
      serializeAttachEvent({
        type: "ready",
        activeProject: "bridge",
        projects: [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }],
      }),
    );
    await waitFor(() => stdout.text().includes("active project: bridge"));

    stdin.write(":project SageTalk\n");
    stdin.write("after switch\n");
    await waitFor(() => received.length === 2);
    assert.deepEqual(received[1], { type: "command", name: "project", value: "SageTalk" });

    clientSocket?.write(
      serializeAttachEvent({
        type: "ready",
        activeProject: "SageTalk",
        projects: [{ alias: "SageTalk", cwd: "/tmp/sage", ready: true, active: true }],
      }),
    );
    await waitFor(() => received.length === 3);
    clientSocket?.end();
    await run;

    assert.deepEqual(received[2], { type: "prompt", project: "SageTalk", text: "after switch" });
  } finally {
    clientSocket?.destroy();
    stdin.destroy();
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach drains valid server events preserved after a bad JSONL line", async () => {
  const socketPath = makeSocketPath();
  let clientSocket: Socket | undefined;
  const server = createServer((socket) => {
    clientSocket = socket;
    socket.on("data", () => undefined);
  });
  const stdout = captureOutput();
  await listen(server, socketPath);

  try {
    const run = runAttach({ socketPath, stdin: new PassThrough(), stdout: stdout.stream });
    await waitFor(() => Boolean(clientSocket));
    clientSocket?.write(
      `{bad}\n${serializeAttachEvent({
        type: "ready",
        activeProject: "bridge",
        projects: [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }],
      })}${serializeAttachEvent({ type: "codex_event", project: "bridge", text: "still delivered", timestamp: "2026-04-27T00:00:00.000Z" })}`,
    );
    await waitFor(() => stdout.text().includes("still delivered"));
    clientSocket?.end();
    await run;

    assert.match(stdout.text(), /error: Invalid JSONL message/);
  } finally {
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach rejects when the daemon closes before ready", async () => {
  const socketPath = makeSocketPath();
  let acceptedConnection = false;
  const server = createServer((socket) => {
    acceptedConnection = true;
    setImmediate(() => socket.destroy());
  });
  const stdout = captureOutput();
  await listen(server, socketPath);

  try {
    const run = runAttach({ socketPath, stdin: new PassThrough(), stdout: stdout.stream });
    const rejected = assert.rejects(run, /closed before ready/);
    await waitFor(() => acceptedConnection);
    await rejected;
  } finally {
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach rejects after reporting a clear error when the daemon socket is unavailable", async () => {
  const socketPath = makeSocketPath();
  const stdout = captureOutput();

  await assert.rejects(runAttach({ socketPath, stdin: new PassThrough(), stdout: stdout.stream }), /Unable to connect/);

  assert.match(stdout.text(), /Unable to connect to wechat-agent-bridge daemon/);
  await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
});

function makeSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wcb-attach-client-")), "bridge.sock");
}

function captureOutput(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(""),
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}
