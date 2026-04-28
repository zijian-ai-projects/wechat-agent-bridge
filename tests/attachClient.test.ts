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
    stdin.destroy();
    await closeServer(server);
    await rm(socketPath.split("/bridge.sock")[0], { recursive: true, force: true });
  }
});

test("runAttach reports a clear error when the daemon socket is unavailable", async () => {
  const socketPath = makeSocketPath();
  const stdout = captureOutput();

  await runAttach({ socketPath, stdin: new PassThrough(), stdout: stdout.stream });

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
