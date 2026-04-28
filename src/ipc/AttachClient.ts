import { connect, type Socket } from "node:net";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { getAttachSocketPath } from "../config/paths.js";
import { parseAttachInput } from "./attachCommands.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachClientMessage, type AttachServerEvent } from "./protocol.js";

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
  let waitingForProjectReady = false;
  const pendingInput: string[] = [];

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeReadline(readline);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeReadline(readline);
      socket.destroy();
      reject(error);
    };

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
    socket.once("end", () => {
      if (!ready) fail(new Error("Attach daemon closed before ready"));
      else if (waitingForProjectReady || pendingInput.length > 0) fail(new Error("Attach daemon closed before pending input was delivered"));
    });
    socket.once("close", () => {
      if (!ready) {
        fail(new Error("Attach daemon closed before ready"));
        return;
      }
      if (waitingForProjectReady || pendingInput.length > 0) {
        fail(new Error("Attach daemon closed before pending input was delivered"));
        return;
      }
      finish();
    });

    readline.on("line", (line) => {
      pendingInput.push(line);
      processInputQueue();
    });
    readline.once("close", () => {
      inputClosed = true;
      processInputQueue();
    });

    function processServerEvents(events: AttachServerEvent[]): void {
      for (const event of events) {
        if (event.type === "ready") {
          activeProject = event.activeProject;
          ready = true;
          waitingForProjectReady = false;
        }
        output.write(`${renderAttachEvent(event)}\n`);
      }
      processInputQueue();
    }

    function processInputQueue(): void {
      if (!ready || waitingForProjectReady || socket.destroyed) return;
      while (pendingInput.length > 0 && !waitingForProjectReady && !socket.destroyed) {
        const line = pendingInput.shift();
        if (line === undefined) continue;
        const message = parseAttachInput(line, activeProject);
        if (!message) continue;
        socket.write(serializeAttachMessage(message));
        if (isProjectSwitchCommand(message)) {
          waitingForProjectReady = true;
        }
      }
      endIfInputComplete(socket, inputClosed, pendingInput, waitingForProjectReady);
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

function isProjectSwitchCommand(message: AttachClientMessage): boolean {
  return message.type === "command" && message.name === "project";
}

function endIfInputComplete(socket: Socket, inputClosed: boolean, pendingInput: string[], waitingForProjectReady: boolean): void {
  if (!inputClosed || pendingInput.length > 0 || waitingForProjectReady || socket.destroyed) return;
  socket.end();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
