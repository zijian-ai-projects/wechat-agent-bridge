import { spawnSync } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

import { assertGitRepo, findGitRoot } from "./git.js";
import { expandHome } from "./security.js";
import type { BridgeConfig, ProjectConfigEntry } from "./config.js";

const PROJECT_ALIAS_RE = /^[A-Za-z0-9_-]+$/;

export interface ProjectConfigShape {
  defaultProject?: string;
  projects?: Record<string, ProjectConfigEntry>;
}

export interface ProjectDefinition {
  alias: string;
  cwd: string;
}

export interface DiscoveredProject extends ProjectDefinition {
  ready: boolean;
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
  const projects: Record<string, ProjectConfigEntry> = Object.create(null);
  for (const root of roots) {
    const baseAlias = sanitizeLegacyProjectAlias(basename(root));
    let alias = baseAlias;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(projects, alias)) {
      alias = `${baseAlias}-${suffix}`;
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
    const cwd = await resolveProjectCwd(project.cwd);
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

export class ProjectCatalog {
  constructor(readonly projectsRoot: string) {}

  async list(): Promise<DiscoveredProject[]> {
    const entries = await readdir(this.projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const cwd = await realpath(resolve(this.projectsRoot, entry.name));
          const gitRoot = await findGitRoot(cwd);
          return {
            alias: entry.name,
            cwd,
            ready: gitRoot === cwd,
          };
        }),
    );
    return projects.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async get(alias: string): Promise<DiscoveredProject | undefined> {
    return (await this.list()).find((project) => project.alias === alias);
  }

  async resolveInitialProject(defaultProject: string, lastProject?: string): Promise<DiscoveredProject> {
    const projects = await this.list();
    for (const alias of [lastProject, defaultProject]) {
      if (!alias) continue;
      const project = projects.find((item) => item.alias === alias);
      if (project) return project;
    }
    throw new Error("未找到可用项目，请重新运行 npm run setup");
  }

  async init(alias: string): Promise<DiscoveredProject> {
    const project = await this.get(alias);
    if (!project) {
      throw new Error(`Unknown project: ${alias}`);
    }
    const result = spawnSync("git", ["init", project.cwd], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git init 失败: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const refreshed = await this.get(alias);
    if (!refreshed?.ready) {
      throw new Error(`git init 未成功初始化项目: ${alias}`);
    }
    return refreshed;
  }
}

export async function resolveProjectsRootConfig(config: BridgeConfig): Promise<{ projectsRoot: string; defaultProject: string }> {
  if (config.projectsRoot) {
    return {
      projectsRoot: await resolveProjectCwd(config.projectsRoot),
      defaultProject: config.defaultProject,
    };
  }

  const projects = config.projects ?? {};
  if (Object.keys(projects).length === 0) {
    throw new Error("未配置 projectsRoot，请运行 npm run setup");
  }

  await assertLegacyProjectRoots(projects);
  const parents = [...new Set((await Promise.all(Object.values(projects).map((project) => resolveProjectCwd(project.cwd)))).map((cwd) => dirname(cwd)))];
  if (parents.length !== 1) {
    throw new Error("旧配置跨越多个项目根目录，请运行 npm run setup");
  }
  return {
    projectsRoot: parents[0],
    defaultProject: config.defaultProject || basename(Object.values(projects)[0].cwd),
  };
}

function sanitizeLegacyProjectAlias(input: string): string {
  const alias = input.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return alias || "project";
}

async function resolveProjectCwd(inputPath: string): Promise<string> {
  const expanded = expandHome(inputPath.trim());
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded);
  return realpath(absolute);
}

async function assertLegacyProjectRoots(projects: Record<string, ProjectConfigEntry>): Promise<void> {
  await Promise.all(
    Object.entries(projects).map(async ([alias, project]) => {
      const cwd = await resolveProjectCwd(project.cwd);
      const gitRoot = await assertGitRepo(cwd);
      if (gitRoot !== cwd) {
        throw new Error(`Legacy project ${alias} must stay at a Git repo root: ${cwd}`);
      }
    }),
  );
}
