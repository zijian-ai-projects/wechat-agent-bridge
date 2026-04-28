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
  let inputClosed = false;
  let ready = false;
  const pendingInput: string[] = [];

  return await new Promise<void>((resolve, reject) => {
    const finish = once(() => {
      closeReadline(readline);
      resolve();
    });
    const fail = once((error: Error) => {
      closeReadline(readline);
      reject(error);
    });

    socket.once("connect", () => {
      socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", ...(options.project ? { project: options.project } : {}) }));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        processServerEvents(buffer.push(chunk.toString("utf8")));
      } catch (error) {
        output.write(`error: ${errorMessage(error)}\n`);
        try {
          processServerEvents(buffer.push(""));
        } catch (drainError) {
          output.write(`error: ${errorMessage(drainError)}\n`);
        }
      }
    });
    socket.once("error", (error) => {
      const message = `Unable to connect to wechat-agent-bridge daemon: ${error.message}`;
      output.write(`${message}\n`);
      output.write("Start it with: npm run start or npm run daemon -- start\n");
      fail(new Error(message));
    });
    socket.once("close", finish);

    readline.on("line", (line) => {
      if (!ready) {
        pendingInput.push(line);
        return;
      }
      writeInputLine(socket, line, activeProject);
    });
    readline.once("close", () => {
      inputClosed = true;
      endIfInputComplete(socket, ready, pendingInput);
    });

    function processServerEvents(events: AttachServerEvent[]): void {
      for (const event of events) {
        if (event.type === "ready") {
          activeProject = event.activeProject;
          ready = true;
        }
        output.write(`${renderAttachEvent(event)}\n`);
      }
      if (ready) {
        flushPendingInput(socket, pendingInput, activeProject);
        endIfInputComplete(socket, inputClosed, pendingInput);
      }
    }
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

function once<T extends unknown[]>(callback: (...args: T) => void): (...args: T) => void {
  let called = false;
  return (...args: T) => {
    if (called) return;
    called = true;
    callback(...args);
  };
}

function flushPendingInput(socket: Socket, pendingInput: string[], activeProject?: string): void {
  while (pendingInput.length > 0) {
    const line = pendingInput.shift();
    if (line !== undefined) writeInputLine(socket, line, activeProject);
  }
}

function writeInputLine(socket: Socket, line: string, activeProject?: string): void {
  const message = parseAttachInput(line, activeProject);
  if (!message || socket.destroyed) return;
  socket.write(serializeAttachMessage(message));
}

function endIfInputComplete(socket: Socket, inputClosed: boolean, pendingInput: string[]): void {
  if (!inputClosed || pendingInput.length > 0 || socket.destroyed) return;
  socket.end();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
