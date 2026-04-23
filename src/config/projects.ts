import { realpath } from "node:fs/promises";
import { basename } from "node:path";

import { assertGitRepo } from "./git.js";
import type { ProjectConfigEntry } from "./config.js";

const PROJECT_ALIAS_RE = /^[A-Za-z0-9_-]+$/;

export interface ProjectConfigShape {
  defaultProject?: string;
  projects?: Record<string, ProjectConfigEntry>;
}

export interface ProjectDefinition {
  alias: string;
  cwd: string;
}

export class ProjectRegistry {
  constructor(
    readonly defaultAlias: string,
    private readonly projectsByAlias: Map<string, ProjectDefinition>,
  ) {}

  get defaultProject(): ProjectDefinition {
    return this.get(this.defaultAlias);
  }

  get(alias: string): ProjectDefinition {
    const project = this.projectsByAlias.get(alias);
    if (!project) {
      throw new Error(`Unknown project: ${alias}. Available projects: ${this.list().map((item) => item.alias).join(", ")}`);
    }
    return project;
  }

  list(): ProjectDefinition[] {
    return [...this.projectsByAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  has(alias: string): boolean {
    return this.projectsByAlias.has(alias);
  }

  findByCwd(cwd: string): ProjectDefinition | undefined {
    return this.list().find((project) => project.cwd === cwd);
  }
}

export function validateProjectAlias(alias: string): string {
  if (!PROJECT_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid project alias: ${alias}. Use letters, numbers, "_", or "-".`);
  }
  return alias;
}

export function createLegacyProjects(defaultCwd: string, allowlistRoots: string[]): Required<ProjectConfigShape> {
  const roots = allowlistRoots.length > 0 ? allowlistRoots : [defaultCwd];
  const projects: Record<string, ProjectConfigEntry> = {};
  for (const root of roots) {
    let alias = basename(root) || "default";
    let suffix = 2;
    while (projects[alias]) {
      alias = `${basename(root) || "default"}-${suffix}`;
      suffix += 1;
    }
    projects[alias] = { cwd: root };
  }
  const defaultProject =
    Object.entries(projects).find(([, project]) => project.cwd === defaultCwd)?.[0] ?? Object.keys(projects)[0];
  return { defaultProject, projects };
}

export async function resolveProjectRegistry(config: ProjectConfigShape): Promise<ProjectRegistry> {
  const entries = Object.entries(config.projects ?? {});
  if (entries.length === 0) throw new Error("No projects configured.");

  const projectsByAlias = new Map<string, ProjectDefinition>();
  const seenCwds = new Map<string, string>();
  for (const [alias, project] of entries) {
    validateProjectAlias(alias);
    const cwd = await realpath(project.cwd);
    const gitRoot = await assertGitRepo(cwd);
    if (gitRoot !== cwd) {
      throw new Error(`Project ${alias} cwd must be a Git repo root: ${cwd}`);
    }
    const previousAlias = seenCwds.get(cwd);
    if (previousAlias) {
      throw new Error(`Projects ${previousAlias} and ${alias} resolve to the same cwd: ${cwd}`);
    }
    seenCwds.set(cwd, alias);
    projectsByAlias.set(alias, { alias, cwd });
  }

  const defaultAlias = config.defaultProject ?? entries[0][0];
  validateProjectAlias(defaultAlias);
  if (!projectsByAlias.has(defaultAlias)) {
    throw new Error(`Default project does not exist: ${defaultAlias}`);
  }

  return new ProjectRegistry(defaultAlias, projectsByAlias);
}
