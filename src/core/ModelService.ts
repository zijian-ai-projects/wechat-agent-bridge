import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeModelSource } from "./EventBus.js";
import type { ProjectSession } from "../session/types.js";

const execFileAsync = promisify(execFile);
const CODEX_CLI_DEFAULT = "Codex CLI default";
const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 5000;

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
      const { stdout } = await execFileAsync(this.codexBin, ["debug", "models"], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: this.modelCatalogTimeoutMs,
      });
      return parseCodexModelCatalog(stdout);
    } catch {
      throw new Error("Unable to read Codex model catalog.");
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
