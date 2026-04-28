import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BridgeModelSource } from "./EventBus.js";
import type { ProjectSession } from "../session/types.js";

const CODEX_CLI_DEFAULT = "Codex CLI default";
const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 5000;
const MODEL_CATALOG_MAX_BUFFER = 8 * 1024 * 1024;

export interface ModelState {
  configuredModel?: string;
  codexDefaultModel?: string;
  effectiveModel: string;
  source: BridgeModelSource;
}

export interface ModelCatalogEntry {
  slug: string;
  displayName?: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: Array<{ effort?: string; description?: string }>;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
}

export interface ModelServiceOptions {
  codexHome?: string;
  codexBin?: string;
  modelCatalogTimeoutMs?: number;
}

export class ModelService {
  private readonly codexHome: string;
  private readonly codexBin: string;
  private readonly modelCatalogTimeoutMs: number;

  constructor(options: ModelServiceOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.codexBin = options.codexBin ?? "codex";
    this.modelCatalogTimeoutMs = options.modelCatalogTimeoutMs ?? DEFAULT_MODEL_CATALOG_TIMEOUT_MS;
  }

  async describeSession(session: Pick<ProjectSession, "model">): Promise<ModelState> {
    const configuredModel = session.model?.trim() || undefined;
    const codexDefaultModel = await this.readCodexDefaultModel();
    if (configuredModel) {
      return { configuredModel, codexDefaultModel, effectiveModel: configuredModel, source: "project override" };
    }
    if (codexDefaultModel) {
      return { codexDefaultModel, effectiveModel: codexDefaultModel, source: "codex config" };
    }
    return { effectiveModel: CODEX_CLI_DEFAULT, source: "unresolved" };
  }

  async listModels(): Promise<ModelCatalog> {
    try {
      const stdout = await runCodexDebugModels(this.codexBin, this.modelCatalogTimeoutMs);
      return parseCodexModelCatalog(stdout);
    } catch (error) {
      throw new Error(`Unable to read Codex model catalog: ${safeCatalogError(error)}`);
    }
  }

  private async readCodexDefaultModel(): Promise<string | undefined> {
    try {
      return parseCodexDefaultModel(await readFile(join(this.codexHome, "config.toml"), "utf8"));
    } catch {
      return undefined;
    }
  }
}

export function parseCodexDefaultModel(configToml: string): string | undefined {
  for (const line of configToml.split("\n")) {
    if (/^\s*\[/.test(line)) return undefined;
    const match = /^\s*model\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

export function parseCodexModelCatalog(stdout: string): ModelCatalog {
  const jsonLine = stdout.split("\n").find((line) => line.trimStart().startsWith("{"));
  if (!jsonLine) throw new Error("Codex model catalog did not contain JSON output.");
  const raw = JSON.parse(jsonLine) as { models?: unknown };
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models = rawModels
    .map((item): ModelCatalogEntry | undefined => sanitizeModelEntry(item))
    .filter((item): item is ModelCatalogEntry => Boolean(item));
  return { models };
}

async function runCodexDebugModels(codexBin: string, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(codexBin, ["debug", "models"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let tooLarge = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MODEL_CATALOG_MAX_BUFFER) {
        tooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.resume();

    child.once("error", (error) => {
      finish(() => reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Codex CLI not found" : "Codex CLI failed to start")));
    });

    child.once("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`timed out after ${timeoutMs}ms`));
          return;
        }
        if (tooLarge) {
          reject(new Error("catalog output exceeded limit"));
          return;
        }
        if (code !== 0) {
          reject(new Error(code === null ? `terminated by signal ${signal ?? "unknown"}` : `exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      });
    });
  });
}

function safeCatalogError(error: unknown): string {
  if (error instanceof SyntaxError) return "malformed catalog";
  if (error instanceof Error) return error.message;
  return "unknown failure";
}

function sanitizeModelEntry(item: unknown): ModelCatalogEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  if (!slug) return undefined;
  const entry: ModelCatalogEntry = {
    slug,
  };
  assignIfDefined(entry, "displayName", stringField(record.display_name));
  assignIfDefined(entry, "description", stringField(record.description));
  assignIfDefined(entry, "defaultReasoningLevel", stringField(record.default_reasoning_level));
  if (Array.isArray(record.supported_reasoning_levels)) {
    entry.supportedReasoningLevels = record.supported_reasoning_levels
      .map((level) => sanitizeReasoningLevel(level))
      .filter((level): level is { effort?: string; description?: string } => Boolean(level));
  }
  return entry;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeReasoningLevel(level: unknown): { effort?: string; description?: string } | undefined {
  if (!level || typeof level !== "object") return undefined;
  const record = level as Record<string, unknown>;
  const sanitized: { effort?: string; description?: string } = {};
  assignIfDefined(sanitized, "effort", stringField(record.effort));
  assignIfDefined(sanitized, "description", stringField(record.description));
  return sanitized.effort || sanitized.description ? sanitized : undefined;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}
