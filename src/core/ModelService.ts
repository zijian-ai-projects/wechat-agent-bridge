import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeModelSource } from "./EventBus.js";
import type { ProjectSession } from "../session/types.js";

const execFileAsync = promisify(execFile);
const CODEX_CLI_DEFAULT = "Codex CLI default";

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
}

export class ModelService {
  private readonly codexHome: string;
  private readonly codexBin: string;

  constructor(options: ModelServiceOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.codexBin = options.codexBin ?? "codex";
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
    const { stdout } = await execFileAsync(this.codexBin, ["debug", "models"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseCodexModelCatalog(stdout);
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
  const raw = JSON.parse(jsonLine) as { models?: unknown[] };
  const models = (raw.models ?? [])
    .map((item): ModelCatalogEntry | undefined => sanitizeModelEntry(item))
    .filter((item): item is ModelCatalogEntry => Boolean(item));
  return { models };
}

function sanitizeModelEntry(item: unknown): ModelCatalogEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  if (!slug) return undefined;
  return {
    slug,
    displayName: stringField(record.display_name),
    description: stringField(record.description),
    defaultReasoningLevel: stringField(record.default_reasoning_level),
    supportedReasoningLevels: Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels.map((level) => ({
          effort: typeof (level as { effort?: unknown }).effort === "string" ? (level as { effort: string }).effort : undefined,
          description: typeof (level as { description?: unknown }).description === "string" ? (level as { description: string }).description : undefined,
        }))
      : undefined,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
