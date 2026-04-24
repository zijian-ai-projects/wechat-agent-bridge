import { homedir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../config/config.js";
import type { DiscoveredProject } from "../config/projects.js";

interface SetupFlowConfig {
  projectsRoot?: string;
  defaultProject: string;
  streamIntervalMs: number;
  extraWritableRoots: string[];
}

export interface SetupFlowDependencies {
  currentConfig: SetupFlowConfig;
  bindWechat: () => Promise<{ boundUserId: string }>;
  ask: (prompt: string) => Promise<string>;
  resolveProjectsRoot: (input: string) => Promise<string>;
  discoverProjects: (projectsRoot: string) => Promise<DiscoveredProject[]>;
  saveConfig: (config: Pick<BridgeConfig, "projectsRoot" | "defaultProject" | "streamIntervalMs">) => void;
  initGitRepo: (cwd: string) => Promise<void>;
}

export async function runSetupFlow(deps: SetupFlowDependencies): Promise<string> {
  await deps.bindWechat();

  const defaultProjectsRoot = deps.currentConfig.projectsRoot ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "projects");
  const { projectsRoot, projects } = await chooseProjectsRoot(defaultProjectsRoot, deps.ask, deps.resolveProjectsRoot, deps.discoverProjects);

  const selected = await chooseDefaultProject(projects, deps.currentConfig.defaultProject, deps.ask);
  if (!selected.ready) {
    const confirmation = (await deps.ask(`项目 ${selected.alias} 还不是 Git 仓库，是否执行 git init? [y/N]: `)).trim().toLowerCase();
    if (confirmation !== "y" && confirmation !== "yes") {
      throw new Error("默认项目尚未初始化为 Git 仓库。");
    }
    await deps.initGitRepo(selected.cwd);
  }

  deps.saveConfig({
    projectsRoot,
    defaultProject: selected.alias,
    streamIntervalMs: deps.currentConfig.streamIntervalMs,
  });

  return "配置已保存。微信里先发 /project 查看当前项目，也可以用 @ProjectName ... 定向到某个项目。";
}

async function chooseProjectsRoot(
  defaultProjectsRoot: string,
  ask: (prompt: string) => Promise<string>,
  resolveProjectsRoot: (input: string) => Promise<string>,
  discoverProjects: (projectsRoot: string) => Promise<DiscoveredProject[]>,
): Promise<{ projectsRoot: string; projects: DiscoveredProject[] }> {
  let errorMessage: string | undefined;
  while (true) {
    const prompt = errorMessage
      ? `项目根目录 [${defaultProjectsRoot}]:\n${errorMessage}\n> `
      : `项目根目录 [${defaultProjectsRoot}]: `;
    const projectsRootInput = (await ask(prompt)).trim() || defaultProjectsRoot;
    try {
      const projectsRoot = await resolveProjectsRoot(projectsRootInput);
      const projects = await discoverProjects(projectsRoot);
      if (projects.length > 0) {
        return { projectsRoot, projects };
      }
      errorMessage = "项目根目录下没有可用子目录，请先放入项目或重新选择目录。";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
}

async function chooseDefaultProject(
  projects: DiscoveredProject[],
  currentDefaultProject: string,
  ask: (prompt: string) => Promise<string>,
): Promise<DiscoveredProject> {
  const defaultIndex = Math.max(projects.findIndex((project) => project.alias === currentDefaultProject), 0);
  const lines = projects.map((project, index) => {
    const suffix = project.ready ? "" : " (未初始化)";
    const marker = index === defaultIndex ? " [default]" : "";
    return `${index + 1}. ${project.alias}${suffix}${marker}`;
  });
  let errorMessage: string | undefined;
  while (true) {
    const prompt = errorMessage
      ? `选择默认项目:\n${lines.join("\n")}\n${errorMessage}\n> `
      : `选择默认项目:\n${lines.join("\n")}\n> `;
    const selection = (await ask(prompt)).trim();
    const selectedIndex = selection === "" ? defaultIndex : Number.parseInt(selection, 10) - 1;
    const selected = projects[selectedIndex];
    if (selected) {
      return selected;
    }
    errorMessage = "默认项目选择无效。请输入列表中的序号。";
  }
}
