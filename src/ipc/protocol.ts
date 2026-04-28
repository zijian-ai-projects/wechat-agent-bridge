import type { BridgeEvent } from "../core/EventBus.js";
import type { ModelCatalogEntry } from "../core/ModelService.js";

export type AttachCommandName = "status" | "project" | "interrupt" | "replace" | "model" | "models";

export type AttachClientMessage =
  | { type: "hello"; client: "attach-cli"; project?: string }
  | { type: "prompt"; project?: string; text: string }
  | { type: "command"; project?: string; name: "status" | "models" }
  | { type: "command"; name: "project"; value?: string }
  | { type: "command"; project?: string; name: "interrupt" }
  | { type: "command"; project?: string; name: "replace"; text: string }
  | { type: "command"; project?: string; name: "model"; value?: string };

export type AttachServerEvent =
  | BridgeEvent
  | { type: "ready"; activeProject: string; projects: Array<{ alias: string; cwd: string; ready: boolean; active: boolean }> }
  | { type: "models"; models: ModelCatalogEntry[] }
  | { type: "error"; message: string };

export const DEFAULT_JSONL_MAX_LINE_BYTES = 1024 * 1024;

export type JsonLineParser<T> = (value: unknown) => T;

export interface JsonLineBufferOptions<T = unknown> {
  maxLineBytes?: number;
  parse?: JsonLineParser<T>;
}

export class JsonLineBuffer<T = unknown> {
  private pending = "";
  private readonly maxLineBytes: number;
  private readonly parse: JsonLineParser<T>;

  constructor(options: JsonLineBufferOptions<T> = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_JSONL_MAX_LINE_BYTES;
    this.parse = options.parse ?? ((value) => value as T);
  }

  push(chunk: string): T[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";

    if (lines.length === 0) {
      this.assertPendingLineSize();
      return [];
    }

    const parsed: T[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        assertLineSize(line, this.maxLineBytes);
        parsed.push(this.parse(parseJsonLine(line)));
      } catch (error) {
        const pendingTail = dropIfOversized(this.pending, this.maxLineBytes);
        this.pending = preserveUnprocessedLines(lines, index, pendingTail);
        throw error;
      }
    }

    this.assertPendingLineSize();
    return parsed;
  }

  private assertPendingLineSize(): void {
    try {
      assertLineSize(this.pending, this.maxLineBytes);
    } catch (error) {
      this.pending = "";
      throw error;
    }
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

function assertLineSize(line: string, maxLineBytes: number): void {
  if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
    throw new Error(`JSONL message exceeded ${maxLineBytes} bytes.`);
  }
}

function dropIfOversized(line: string, maxLineBytes: number): string {
  return Buffer.byteLength(line, "utf8") > maxLineBytes ? "" : line;
}

function preserveUnprocessedLines(lines: string[], failedIndex: number, pending: string): string {
  const recoverable = [
    ...lines.slice(0, failedIndex).filter((line) => line.trim()),
    ...lines.slice(failedIndex + 1),
  ];
  if (recoverable.length === 0) return pending;
  return `${recoverable.join("\n")}\n${pending}`;
}

export function parseAttachClientMessage(value: unknown): AttachClientMessage {
  const record = requireRecord(value);
  switch (record.type) {
    case "hello":
      if (record.client !== "attach-cli") throw invalidAttachClientMessage("hello.client must be attach-cli");
      return { type: "hello", client: "attach-cli", ...optionalProject(record) };
    case "prompt":
      return { type: "prompt", ...optionalProject(record), text: requiredNonEmptyString(record, "text") };
    case "command":
      return parseAttachCommandMessage(record);
    default:
      throw invalidAttachClientMessage("unknown message type");
  }
}

function parseAttachCommandMessage(record: Record<string, unknown>): AttachClientMessage {
  switch (record.name) {
    case "status":
    case "models":
      return { type: "command", ...optionalProject(record), name: record.name };
    case "project":
      return { type: "command", name: "project", ...optionalValue(record) };
    case "interrupt":
      return { type: "command", ...optionalProject(record), name: "interrupt" };
    case "replace":
      return { type: "command", ...optionalProject(record), name: "replace", text: requiredNonEmptyString(record, "text") };
    case "model":
      return { type: "command", ...optionalProject(record), name: "model", ...optionalValue(record) };
    default:
      throw invalidAttachClientMessage("unknown command name");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidAttachClientMessage("message must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalProject(record: Record<string, unknown>): { project?: string } {
  const project = optionalNonEmptyString(record, "project");
  return project ? { project } : {};
}

function optionalValue(record: Record<string, unknown>): { value?: string } {
  const value = optionalNonEmptyString(record, "value");
  return value ? { value } : {};
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidAttachClientMessage(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw invalidAttachClientMessage(`${key} must be a non-empty string`);
  }
  return value;
}

function invalidAttachClientMessage(reason: string): Error {
  return new Error(`Invalid attach client message: ${reason}.`);
}
