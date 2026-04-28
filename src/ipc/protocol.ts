import type { BridgeEvent } from "../core/EventBus.js";
import type { ModelCatalogEntry } from "../core/ModelService.js";

export type AttachCommandName = "status" | "project" | "interrupt" | "replace" | "model" | "models";

export type AttachClientMessage =
  | { type: "hello"; client: "attach-cli"; project?: string }
  | { type: "prompt"; project?: string; text: string }
  | { type: "command"; project?: string; name: AttachCommandName; value?: string; text?: string };

export type AttachServerEvent =
  | BridgeEvent
  | { type: "ready"; activeProject: string; projects: Array<{ alias: string; cwd: string; ready: boolean; active: boolean }> }
  | { type: "models"; models: ModelCatalogEntry[] }
  | { type: "error"; message: string };

export class JsonLineBuffer {
  private pending = "";

  push(chunk: string): unknown[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";

    return lines.filter((line) => line.trim()).map((line) => parseJsonLine(line));
  }
}

export function serializeAttachEvent(event: AttachServerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function serializeAttachMessage(message: AttachClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL message: ${message}`);
  }
}
