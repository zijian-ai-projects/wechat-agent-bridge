import { connect, type Socket } from "node:net";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { getAttachSocketPath } from "../config/paths.js";
import { parseAttachInput } from "./attachCommands.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachServerEvent } from "./protocol.js";

export interface RunAttachOptions {
  project?: string;
  socketPath?: string;
  stdin?: Readable;
  stdout?: Writable;
}

export async function runAttach(options: RunAttachOptions = {}): Promise<void> {
  const socketPath = options.socketPath ?? getAttachSocketPath();
  const input = options.stdin ?? defaultStdin;
  const output = options.stdout ?? defaultStdout;
  const socket = connect(socketPath);
  const buffer = new JsonLineBuffer<AttachServerEvent>();
  const readline = createInterface({ input, terminal: false });
  let activeProject = options.project;
  let connected = false;

  return await new Promise<void>((resolve) => {
    const finish = once(() => {
      closeReadline(readline);
      resolve();
    });

    socket.once("connect", () => {
      connected = true;
      socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", ...(options.project ? { project: options.project } : {}) }));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const event of buffer.push(chunk.toString("utf8"))) {
          if (event.type === "ready") activeProject = event.activeProject;
          output.write(`${renderAttachEvent(event)}\n`);
        }
      } catch (error) {
        output.write(`error: ${errorMessage(error)}\n`);
      }
    });
    socket.once("error", (error) => {
      output.write(`Unable to connect to wechat-agent-bridge daemon: ${error.message}\n`);
      output.write("Start it with: npm run start or npm run daemon -- start\n");
    });
    socket.once("close", finish);

    readline.on("line", (line) => {
      const message = parseAttachInput(line, activeProject);
      if (!message || socket.destroyed) return;
      socket.write(serializeAttachMessage(message));
    });
    readline.once("close", () => {
      if (socket.destroyed) return;
      if (connected) socket.end();
      else socket.destroy();
    });
  });
}

export function renderAttachEvent(event: AttachServerEvent): string {
  switch (event.type) {
    case "ready":
      return [
        "connected to wechat-agent-bridge",
        `active project: ${event.activeProject}`,
        `projects: ${event.projects.map((project) => `${project.active ? "*" : " "}${project.alias}${project.ready ? "" : " (needs init)"}`).join(", ")}`,
      ].join("\n");
    case "user_message":
      return `[${event.project}] ${event.source}: ${event.text}`;
    case "turn_started":
      return [
        `[${event.project}] Codex started`,
        `source: ${event.source}`,
        `mode: ${event.mode}`,
        `model: ${event.model}`,
        `model source: ${event.modelSource}`,
      ].join("\n");
    case "codex_event":
      return `[${event.project}] ${event.text}`;
    case "turn_completed":
      return `[${event.project}] completed${event.text ? `\n${event.text}` : ""}`;
    case "turn_failed":
      return `[${event.project}] failed: ${event.message}`;
    case "state":
      return `[${event.project}] state: ${event.state} | model: ${event.model} | source: ${event.modelSource}`;
    case "models":
      return [
        "available models:",
        ...event.models.map((model) => `- ${model.slug}${model.displayName ? ` (${model.displayName})` : ""}`),
      ].join("\n");
    case "error":
      return `error: ${event.message}`;
  }
}

function closeReadline(readline: Interface): void {
  try {
    readline.close();
  } catch {
    // Closing an already closed readline interface is harmless.
  }
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
