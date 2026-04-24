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
  const projectsRootInput = (await deps.ask(`项目根目录 [${defaultProjectsRoot}]: `)).trim() || defaultProjectsRoot;
  const projectsRoot = await deps.resolveProjectsRoot(projectsRootInput);
  const projects = await deps.discoverProjects(projectsRoot);
  if (projects.length === 0) {
    throw new Error("项目根目录下没有可用子目录，请先放入项目或重新选择目录。");
  }

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
  const selection = (await ask(`选择默认项目:\n${lines.join("\n")}\n> `)).trim();
  const selectedIndex = selection === "" ? defaultIndex : Number.parseInt(selection, 10) - 1;
  const selected = projects[selectedIndex];
  if (!selected) {
    throw new Error("默认项目选择无效。");
  }
  return selected;
}
