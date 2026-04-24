import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { createLegacyProjects } from "./projects.js";
import { getConfigPath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface ProjectConfigEntry {
  cwd: string;
}

export interface BridgeConfig {
  projectsRoot?: string;
  defaultCwd: string;
  allowlistRoots: string[];
  extraWritableRoots: string[];
  streamIntervalMs: number;
  defaultProject: string;
  projects?: Record<string, ProjectConfigEntry>;
}

type BridgeConfigInput = Partial<BridgeConfig>;

function normalizeProjects(config: BridgeConfigInput): BridgeConfig {
  if (config.projectsRoot) {
    const projectsRoot = safeRealpath(config.projectsRoot);
    const fallbackDefaultCwd = safeRealpath(config.defaultCwd ?? process.cwd());
    const defaultProject = config.defaultProject ?? "default";
    const candidateDefaultCwd = join(projectsRoot, defaultProject);
    const defaultCwd = existsSync(candidateDefaultCwd) ? safeRealpath(candidateDefaultCwd) : fallbackDefaultCwd;
    return {
      projectsRoot,
      defaultCwd,
      allowlistRoots: config.allowlistRoots?.length ? config.allowlistRoots.map(safeRealpath) : [defaultCwd],
      extraWritableRoots: config.extraWritableRoots ?? [],
      streamIntervalMs: config.streamIntervalMs ?? 10_000,
      defaultProject,
      projects: config.projects,
    };
  }

  const defaultCwd = safeRealpath(config.defaultCwd ?? process.cwd());
  const allowlistRoots = config.allowlistRoots?.length ? config.allowlistRoots.map(safeRealpath) : [defaultCwd];

  if (config.projects === undefined) {
    const legacy = createLegacyProjects(defaultCwd, allowlistRoots);
    return {
      defaultCwd,
      allowlistRoots,
      extraWritableRoots: config.extraWritableRoots ?? [],
      streamIntervalMs: config.streamIntervalMs ?? 10_000,
      defaultProject: legacy.defaultProject,
      projects: legacy.projects,
    };
  }

  const projectEntries = Object.entries(config.projects);
  const defaultProject = config.defaultProject;
  const hasValidDefaultProject =
    defaultProject !== undefined && Object.prototype.hasOwnProperty.call(config.projects, defaultProject);

  if (hasValidDefaultProject) {
    const normalizedRoots = projectEntries.map(([, project]) => safeRealpath(project.cwd));
    return {
      defaultCwd: safeRealpath(config.projects[defaultProject].cwd),
      allowlistRoots: normalizedRoots,
      extraWritableRoots: config.extraWritableRoots ?? [],
      streamIntervalMs: config.streamIntervalMs ?? 10_000,
      defaultProject,
      projects: config.projects,
    };
  }

  return {
    defaultCwd,
    allowlistRoots,
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    defaultProject: config.defaultProject ?? "",
    projects: config.projects,
  };
}

export function loadConfig(): BridgeConfig {
  return normalizeProjects(loadSecureJson<BridgeConfigInput>(getConfigPath(), {}));
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
