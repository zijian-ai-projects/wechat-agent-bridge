import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { nowIso, type BridgeEvent, type BridgeEventBus } from "../core/EventBus.js";
import type { ModelService } from "../core/ModelService.js";
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import { logger } from "../logging/logger.js";
import {
  JsonLineBuffer,
  parseAttachClientMessage,
  serializeAttachEvent,
  type AttachClientMessage,
  type AttachServerEvent,
} from "./protocol.js";

const MAX_ATTACH_SOCKET_BUFFER_BYTES = 1024 * 1024;

export interface AttachServerOptions {
  socketPath: string;
  eventBus: BridgeEventBus;
  projectManager: Pick<
    ProjectRuntimeManager,
    | "activeProjectAlias"
    | "listProjects"
    | "runPrompt"
    | "interrupt"
    | "replacePrompt"
    | "setModel"
    | "setActiveProject"
    | "session"
  >;
  boundUserId: string;
  sendWechatText: (text: string) => Promise<void>;
  modelService: Pick<ModelService, "listModels" | "describeSession">;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

export class AttachServer {
  private readonly clients = new Set<Socket>();
  private readonly server: Server;
  private socketIdentity?: SocketIdentity;
  private started = false;
  private unsubscribe?: () => void;

  constructor(private readonly options: AttachServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    if (this.started) return;
    const socketDir = dirname(this.options.socketPath);
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    await chmod(socketDir, 0o700);
    await removeStaleSocket(this.options.socketPath);
    this.unsubscribe = this.options.eventBus.subscribe((event) => this.broadcast(event));
    try {
      await listen(this.server, this.options.socketPath);
      await chmod(this.options.socketPath, 0o600);
      this.started = true;
      this.socketIdentity = await readSocketIdentity(this.options.socketPath);
    } catch (error) {
      this.started = false;
      this.socketIdentity = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await closeServer(this.server);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const wasStarted = this.started;
    const socketIdentity = this.socketIdentity;
    this.started = false;
    this.socketIdentity = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients) {
      client.destroy();
    }
    if (wasStarted) {
      await closeServer(this.server);
    }
    if (socketIdentity) {
      await removeSocketIfOwned(this.options.socketPath, socketIdentity);
    }
  }

  private accept(socket: Socket): void {
    const buffer = new JsonLineBuffer<AttachClientMessage>({ parse: parseAttachClientMessage });
    let messageQueue = Promise.resolve();
    const enqueueMessage = (message: AttachClientMessage): void => {
      messageQueue = messageQueue
        .then(() => this.handleMessage(socket, message))
        .catch((error) => {
          this.send(socket, { type: "error", message: errorMessage(error) });
        });
    };
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      this.clients.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        this.dispatchMessages(enqueueMessage, buffer.push(chunk.toString("utf8")));
      } catch (error) {
        this.send(socket, { type: "error", message: errorMessage(error) });
        this.drainPreservedMessages(socket, buffer, enqueueMessage);
      }
    });
  }

  private drainPreservedMessages(
    socket: Socket,
    buffer: JsonLineBuffer<AttachClientMessage>,
    enqueueMessage: (message: AttachClientMessage) => void,
  ): void {
    try {
      this.dispatchMessages(enqueueMessage, buffer.push(""));
    } catch (error) {
      this.send(socket, { type: "error", message: errorMessage(error) });
    }
  }

  private dispatchMessages(enqueueMessage: (message: AttachClientMessage) => void, messages: AttachClientMessage[]): void {
    for (const message of messages) {
      enqueueMessage(message);
    }
  }

  private async handleMessage(socket: Socket, message: AttachClientMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        await this.switchActiveProject(socket, message.project);
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
    await this.waitForAcceptedPrompt(({ onAccepted }) =>
      this.options.projectManager.runPrompt({
        ...(message.project ? { projectAlias: message.project } : {}),
        prompt: message.text,
        toUserId: this.options.boundUserId,
        contextToken: "",
        source: "attach",
        onAccepted: (projectAlias) => {
          onAccepted(projectAlias);
          this.mirrorAttachPrompt(projectAlias, message.text);
        },
      }),
    );
  }

  private async waitForAcceptedPrompt(
    runPrompt: (callbacks: { onAccepted: (projectAlias: string) => void }) => Promise<void>,
  ): Promise<void> {
    let acceptedProject: string | undefined;
    let resolveAccepted!: () => void;
    let rejectBeforeAccepted!: (error: unknown) => void;
    const acceptedOrRejected = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectBeforeAccepted = reject;
    });
    const turn = runPrompt({
      onAccepted: (projectAlias) => {
        if (acceptedProject) return;
        acceptedProject = projectAlias;
        resolveAccepted();
      },
    });
    void turn.then(
      () => {
        if (!acceptedProject) resolveAccepted();
      },
      (error) => {
        if (!acceptedProject) {
          rejectBeforeAccepted(error);
          return;
        }
        logger.warn("Attach prompt failed after acceptance", { error: errorMessage(error), project: acceptedProject });
      },
    );
    await acceptedOrRejected;
  }

  private async handleCommand(socket: Socket, message: Extract<AttachClientMessage, { type: "command" }>): Promise<void> {
    switch (message.name) {
      case "status":
        this.send(socket, await this.readyEvent());
        return;
      case "project":
        await this.switchActiveProject(socket, message.value);
        this.send(socket, await this.readyEvent());
        return;
      case "interrupt":
        await this.options.projectManager.interrupt(message.project);
        return;
      case "replace":
        await this.waitForAcceptedPrompt(({ onAccepted }) =>
          this.options.projectManager.replacePrompt({
            ...(message.project ? { projectAlias: message.project } : {}),
            prompt: message.text,
            toUserId: this.options.boundUserId,
            contextToken: "",
            source: "attach",
            onAccepted: (projectAlias) => {
              onAccepted(projectAlias);
              this.mirrorAttachPrompt(projectAlias, message.text);
            },
          }),
        );
        return;
      case "model":
        if (message.value === undefined) {
          await this.sendModelState(socket, message.project);
          return;
        }
        await this.sendModelSessionState(socket, await this.options.projectManager.setModel(message.project, message.value));
        return;
      case "models":
        this.send(socket, { type: "models", models: (await this.options.modelService.listModels()).models });
        return;
    }
  }

  private async readyEvent(): Promise<AttachServerEvent> {
    return {
      type: "ready",
      activeProject: this.options.projectManager.activeProjectAlias,
      projects: await this.options.projectManager.listProjects(),
    };
  }

  private async switchActiveProject(socket: Socket, alias?: string): Promise<void> {
    if (!alias) return;
    try {
      await this.options.projectManager.setActiveProject(alias);
    } catch (error) {
      this.send(socket, { type: "error", message: errorMessage(error) });
    }
  }

  private async sendModelState(socket: Socket, alias?: string): Promise<void> {
    await this.sendModelSessionState(socket, await this.options.projectManager.session(alias));
  }

  private async sendModelSessionState(
    socket: Socket,
    session: Awaited<ReturnType<AttachServerOptions["projectManager"]["session"]>>,
  ): Promise<void> {
    const model = await this.options.modelService.describeSession(session);
    this.send(socket, {
      type: "state",
      project: session.projectAlias,
      state: session.state,
      model: model.effectiveModel,
      modelSource: model.source,
      timestamp: nowIso(),
    });
  }

  private mirrorAttachPrompt(projectAlias: string, text: string): void {
    void this.options.sendWechatText(`[${projectAlias}] 桌面输入:\n${text}`).catch((error) => {
      logger.warn("Failed to mirror attach prompt to WeChat", { error: errorMessage(error), project: projectAlias });
    });
  }

  private broadcast(event: BridgeEvent): void {
    for (const client of this.clients) {
      this.send(client, event);
    }
  }

  private send(socket: Socket, event: AttachServerEvent): void {
    if (socket.destroyed) return;
    const payload = serializeAttachEvent(event);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (socket.writableLength + payloadBytes > MAX_ATTACH_SOCKET_BUFFER_BYTES) {
      logger.warn("Disconnecting slow attach client after socket buffer limit", {
        bufferedBytes: socket.writableLength,
        payloadBytes,
      });
      socket.destroy();
      return;
    }
    socket.write(payload);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!(await pathExists(socketPath))) return;
  if (await canConnectToSocket(socketPath)) {
    throw new Error(`Attach socket is already in use: ${socketPath}`);
  }
  await rm(socketPath, { force: true });
}

async function canConnectToSocket(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
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

async function readSocketIdentity(socketPath: string): Promise<SocketIdentity> {
  const stat = await lstat(socketPath);
  return { dev: stat.dev, ino: stat.ino };
}

async function removeSocketIfOwned(socketPath: string, identity: SocketIdentity): Promise<void> {
  let current: SocketIdentity;
  try {
    current = await readSocketIdentity(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current.dev === identity.dev && current.ino === identity.ino) {
    await rm(socketPath, { force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
