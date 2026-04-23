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

function normalizeProjects(config: BridgeConfigInput): Pick<BridgeConfig, "defaultProject" | "projects"> {
  if (config.projects && Object.keys(config.projects).length > 0) {
    const defaultProject = config.defaultProject && config.projects[config.defaultProject]
      ? config.defaultProject
      : Object.keys(config.projects)[0];
    return {
      defaultProject,
      projects: config.projects,
    };
  }

  return createLegacyProjects(config.defaultCwd, config.allowlistRoots);
}

export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<Partial<BridgeConfigInput>>(getConfigPath(), {});
  const defaultCwd = config.defaultCwd ?? cwd;
  const allowlistRoots = config.allowlistRoots?.length ? config.allowlistRoots : [defaultCwd];
  const projects = normalizeProjects({
    defaultCwd,
    allowlistRoots,
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    defaultProject: config.defaultProject,
    projects: config.projects,
  });
  return {
    defaultCwd,
    allowlistRoots,
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    defaultProject: projects.defaultProject,
    projects: projects.projects,
  };
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
