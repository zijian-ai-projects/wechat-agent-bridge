import { realpathSync } from "node:fs";

import { createLegacyProjects } from "./projects.js";
import { getConfigPath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface ProjectConfigEntry {
  cwd: string;
}

export interface BridgeConfig {
  defaultCwd: string;
  allowlistRoots: string[];
  extraWritableRoots: string[];
  streamIntervalMs: number;
  defaultProject: string;
  projects: Record<string, ProjectConfigEntry>;
}

type BridgeConfigInput = Pick<BridgeConfig, "defaultCwd" | "allowlistRoots" | "extraWritableRoots" | "streamIntervalMs"> &
  Partial<Pick<BridgeConfig, "defaultProject" | "projects">>;

function normalizeProjects(config: BridgeConfigInput): BridgeConfig {
  if (config.projects === undefined) {
    const legacy = createLegacyProjects(config.defaultCwd, config.allowlistRoots);
    return {
      defaultCwd: config.defaultCwd,
      allowlistRoots: config.allowlistRoots,
      extraWritableRoots: config.extraWritableRoots,
      streamIntervalMs: config.streamIntervalMs,
      defaultProject: legacy.defaultProject,
      projects: legacy.projects,
    };
  }

  const projectEntries = Object.entries(config.projects);
  const defaultProject = config.defaultProject;
  const hasValidDefaultProject =
    defaultProject !== undefined && Object.prototype.hasOwnProperty.call(config.projects, defaultProject);

  if (hasValidDefaultProject) {
    const allowlistRoots = projectEntries.map(([, project]) => project.cwd);
    return {
      defaultCwd: config.projects[defaultProject].cwd,
      allowlistRoots,
      extraWritableRoots: config.extraWritableRoots,
      streamIntervalMs: config.streamIntervalMs,
      defaultProject,
      projects: config.projects,
    };
  }

  return {
    defaultCwd: config.defaultCwd,
    allowlistRoots: config.allowlistRoots,
    extraWritableRoots: config.extraWritableRoots,
    streamIntervalMs: config.streamIntervalMs,
    defaultProject: config.defaultProject ?? "",
    projects: config.projects,
  };
}

export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<Partial<BridgeConfigInput>>(getConfigPath(), {});
  const defaultCwd = config.defaultCwd ?? cwd;
  const allowlistRoots = config.allowlistRoots?.length ? config.allowlistRoots : [defaultCwd];
  return normalizeProjects({
    defaultCwd,
    allowlistRoots,
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    defaultProject: config.defaultProject,
    projects: config.projects,
  });
}

export function saveConfig(config: BridgeConfigInput): void {
  saveSecureJson(getConfigPath(), config);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
