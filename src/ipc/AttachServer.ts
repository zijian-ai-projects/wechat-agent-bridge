import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { BridgeEvent, BridgeEventBus } from "../core/EventBus.js";
import type { ModelService } from "../core/ModelService.js";
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import {
  JsonLineBuffer,
  parseAttachClientMessage,
  serializeAttachEvent,
  type AttachClientMessage,
  type AttachServerEvent,
} from "./protocol.js";

export interface AttachServerOptions {
  socketPath: string;
  eventBus: BridgeEventBus;
  projectManager: Pick<
    ProjectRuntimeManager,
    "activeProjectAlias" | "listProjects" | "runPrompt" | "interrupt" | "replacePrompt" | "setModel"
  >;
  boundUserId: string;
  sendWechatText: (text: string) => Promise<void>;
  modelService: Pick<ModelService, "listModels">;
}

export class AttachServer {
  private readonly clients = new Set<Socket>();
  private readonly server: Server;
  private unsubscribe?: () => void;

  constructor(private readonly options: AttachServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.options.socketPath, { force: true });
    this.unsubscribe = this.options.eventBus.subscribe((event) => this.broadcast(event));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients) {
      client.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(this.options.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    const buffer = new JsonLineBuffer<AttachClientMessage>({ parse: parseAttachClientMessage });
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      this.clients.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of buffer.push(chunk.toString("utf8"))) {
          void this.handleMessage(socket, message).catch((error) => {
            this.send(socket, { type: "error", message: errorMessage(error) });
          });
        }
      } catch (error) {
        this.send(socket, { type: "error", message: errorMessage(error) });
      }
    });
  }

  private async handleMessage(socket: Socket, message: AttachClientMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        this.send(socket, await this.readyEvent());
        return;
      case "prompt":
        await this.handlePrompt(message);
        return;
      case "command":
        await this.handleCommand(socket, message);
        return;
    }
  }

  private async handlePrompt(message: Extract<AttachClientMessage, { type: "prompt" }>): Promise<void> {
    const project = message.project ?? this.options.projectManager.activeProjectAlias;
    await this.options.sendWechatText(`[${project}] 桌面输入:\n${message.text}`);
    await this.options.projectManager.runPrompt({
      ...(message.project ? { projectAlias: message.project } : {}),
      prompt: message.text,
      toUserId: this.options.boundUserId,
      contextToken: "",
      source: "attach",
    });
  }

  private async handleCommand(socket: Socket, message: Extract<AttachClientMessage, { type: "command" }>): Promise<void> {
    switch (message.name) {
      case "status":
        this.send(socket, await this.readyEvent());
        return;
      case "project":
        this.send(socket, await this.readyEvent(message.value));
        return;
      case "interrupt":
        await this.options.projectManager.interrupt(message.project);
        return;
      case "replace":
        await this.options.projectManager.replacePrompt({
          ...(message.project ? { projectAlias: message.project } : {}),
          prompt: message.text,
          toUserId: this.options.boundUserId,
          contextToken: "",
          source: "attach",
        });
        return;
      case "model":
        await this.options.projectManager.setModel(message.project, message.value);
        return;
      case "models":
        this.send(socket, { type: "models", models: (await this.options.modelService.listModels()).models });
        return;
    }
  }

  private async readyEvent(activeProject = this.options.projectManager.activeProjectAlias): Promise<AttachServerEvent> {
    return {
      type: "ready",
      activeProject,
      projects: await this.options.projectManager.listProjects(),
    };
  }

  private broadcast(event: BridgeEvent): void {
    for (const client of this.clients) {
      this.send(client, event);
    }
  }

  private send(socket: Socket, event: AttachServerEvent): void {
    if (socket.destroyed) return;
    socket.write(serializeAttachEvent(event));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
