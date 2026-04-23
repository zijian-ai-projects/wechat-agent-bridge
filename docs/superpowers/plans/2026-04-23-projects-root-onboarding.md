# Projects Root Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current explicit multi-project config flow with a single `projectsRoot` onboarding path so users can start quickly, switch projects by directory name, and get concise but detailed command help.

**Architecture:** Introduce a root-based project catalog that discovers first-level child directories under `projectsRoot`, persists `lastProject` as runtime state, and lets `ProjectRuntimeManager` resolve projects dynamically instead of relying on a static configured registry. Keep per-project session/runtime isolation, but simplify setup, command help, and README around `/project`, `@project ...`, and a compatibility-only `/cwd`.

**Tech Stack:** TypeScript, Node.js `node:test`, secure JSON config/state files, existing Codex backend/runtime stack, Git CLI for explicit `git init`.

---

## File Structure

- Modify `src/config/config.ts`: replace the documented config shape with `projectsRoot`, keep temporary compatibility reads for old config, and stop writing `defaultCwd`/`allowlistRoots` from setup.
- Modify `src/config/paths.ts`: add a path helper for runtime state storage.
- Create `src/config/runtimeState.ts`: persist `lastProject` separately from user-facing config.
- Modify `tests/projectConfig.test.ts`: cover the new config shape and legacy compatibility reads.
- Create `tests/runtimeState.test.ts`: cover loading and saving `lastProject`.
- Modify `src/config/projects.ts`: turn project resolution into a dynamic catalog rooted at `projectsRoot`, expose first-level discovery, initial-project resolution, and explicit `git init`.
- Modify `tests/projectConfig.test.ts`: add first-level discovery, git readiness, and legacy-root inference coverage there rather than splitting another tiny test file.
- Create `src/setup/flow.ts`: hold a testable setup orchestration that binds WeChat, prompts for `projectsRoot`, picks `defaultProject`, and optionally runs `git init`.
- Modify `src/setup/setup.ts`: keep only the CLI/QR wrapper and delegate the business flow to `runSetupFlow`.
- Create `tests/setupFlow.test.ts`: prove setup writes the new config and prompts for `git init` when the chosen default project is not a repo.
- Modify `src/core/ProjectRuntimeManager.ts`: swap the static registry dependency for the dynamic project catalog, remember the active project, and refresh project lists on demand.
- Modify `src/runtime/bridge.ts`: load runtime state, choose the initial active project from `lastProject` or `defaultProject`, and persist project switches.
- Modify `tests/projectRuntime.test.ts`: cover dynamic project discovery, last-project persistence, and initialization-required failures.
- Modify `tests/bridge.test.ts`: cover startup fallback to `lastProject` and targeted prompt behavior for non-Git projects.
- Create `src/commands/helpCatalog.ts`: define the single source of truth for command summaries and detailed help text.
- Modify `src/commands/router.ts` and `src/commands/handlers.ts`: implement `/help <command>`, simplify `/help`, support `/project <name> --init`, and keep `/cwd` as a compatibility command.
- Modify `src/core/BridgeService.ts`: make targeted prompt routing async against the dynamic project catalog and return initialization guidance for non-Git projects.
- Modify `tests/commands.test.ts`: cover the streamlined help output, detailed command help, project init confirmation, and compatibility `/cwd`.
- Create `docs/commands.md`: provide the full command reference that mirrors `/help <command>`.
- Modify `README.md`, `README_EN.md`, `README_ES.md`, `README_JA.md`, and `README_KO.md`: rewrite onboarding around `projectsRoot`, `/project`, and `@project ...`.

---

### Task 1: Normalize Config And Add Runtime State

**Files:**
- Modify: `src/config/config.ts`
- Modify: `src/config/paths.ts`
- Create: `src/config/runtimeState.ts`
- Test: `tests/projectConfig.test.ts`
- Test: `tests/runtimeState.test.ts`

- [ ] **Step 1: Write failing tests for the new config shape**

Add this test near the top of `tests/projectConfig.test.ts`:

```ts
test("loadConfig reads the new projectsRoot config shape without synthesizing legacy fields", async () => {
  await withTempConfigHome(async () => {
    const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-")));
    try {
      saveSecureJson(getConfigPath(), {
        projectsRoot: root,
        defaultProject: "SageTalk",
        streamIntervalMs: 2500,
      });

      const config = loadConfig();

      assert.equal(config.projectsRoot, root);
      assert.equal(config.defaultProject, "SageTalk");
      assert.equal(config.streamIntervalMs, 2500);
      assert.deepEqual(config.extraWritableRoots, []);
      assert.equal(config.defaultCwd, undefined);
      assert.equal(config.allowlistRoots, undefined);
      assert.equal(config.projects, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Create `tests/runtimeState.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRuntimeState, saveRuntimeState } from "../src/config/runtimeState.js";

test("runtime state persists lastProject separately from config", async () => {
  const previousHome = process.env.WECHAT_AGENT_BRIDGE_HOME;
  const home = await realpath(mkdtempSync(join(tmpdir(), "wcb-runtime-state-")));
  process.env.WECHAT_AGENT_BRIDGE_HOME = home;

  try {
    assert.deepEqual(loadRuntimeState(), {});

    saveRuntimeState({ lastProject: "SageTalk" });

    assert.deepEqual(loadRuntimeState(), { lastProject: "SageTalk" });
  } finally {
    if (previousHome === undefined) {
      delete process.env.WECHAT_AGENT_BRIDGE_HOME;
    } else {
      process.env.WECHAT_AGENT_BRIDGE_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npx tsx --test tests/projectConfig.test.ts tests/runtimeState.test.ts
```

Expected: failure because `projectsRoot` and `runtimeState` support do not exist yet.

- [ ] **Step 3: Update the config types and loader**

Edit `src/config/config.ts` so the new user-facing shape is first-class and legacy fields are optional compatibility inputs:

```ts
export interface ProjectConfigEntry {
  cwd: string;
}

export interface BridgeConfig {
  projectsRoot?: string;
  defaultProject: string;
  streamIntervalMs: number;
  extraWritableRoots: string[];
  defaultCwd?: string;
  allowlistRoots?: string[];
  projects?: Record<string, ProjectConfigEntry>;
}

type BridgeConfigInput = Partial<BridgeConfig>;

export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<BridgeConfigInput>(getConfigPath(), {});

  return {
    projectsRoot: config.projectsRoot ? safeRealpath(config.projectsRoot) : undefined,
    defaultProject: config.defaultProject ?? basename(cwd),
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    extraWritableRoots: config.extraWritableRoots ?? [],
    defaultCwd: config.defaultCwd ? safeRealpath(config.defaultCwd) : undefined,
    allowlistRoots: config.allowlistRoots?.map((root) => safeRealpath(root)),
    projects: config.projects,
  };
}

export function saveConfig(config: Pick<BridgeConfig, "projectsRoot" | "defaultProject" | "streamIntervalMs">): void {
  saveSecureJson(getConfigPath(), config);
}
```

Also add the missing import:

```ts
import { basename } from "node:path";
```

- [ ] **Step 4: Add runtime-state storage helpers**

Edit `src/config/paths.ts`:

```ts
export function getRuntimeStatePath(): string {
  return join(getDataDir(), "runtime-state.json");
}
```

Create `src/config/runtimeState.ts`:

```ts
import { getRuntimeStatePath } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";

export interface BridgeRuntimeState {
  lastProject?: string;
}

export function loadRuntimeState(): BridgeRuntimeState {
  return loadSecureJson<BridgeRuntimeState>(getRuntimeStatePath(), {});
}

export function saveRuntimeState(state: BridgeRuntimeState): void {
  saveSecureJson(getRuntimeStatePath(), state);
}
```

- [ ] **Step 5: Re-run the focused tests**

Run:

```bash
npx tsx --test tests/projectConfig.test.ts tests/runtimeState.test.ts
```

Expected: PASS for the new config/runtime-state assertions and any existing `projectConfig` coverage that still compiles.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts src/config/paths.ts src/config/runtimeState.ts tests/projectConfig.test.ts tests/runtimeState.test.ts
git commit -m "feat: add projects-root config and runtime state"
```

---

### Task 2: Build A Dynamic Project Catalog From `projectsRoot`

**Files:**
- Modify: `src/config/projects.ts`
- Test: `tests/projectConfig.test.ts`

- [ ] **Step 1: Write failing discovery and legacy-inference tests**

Append these tests to `tests/projectConfig.test.ts`:

```ts
test("project catalog lists only first-level child directories and marks git readiness", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-project-root-")));
  const bridge = join(root, "bridge");
  const scratch = join(root, "scratch");
  const nestedParent = join(root, "nested");
  const nestedRepo = join(nestedParent, "inner");

  mkdirSync(join(bridge, ".git"), { recursive: true });
  await writeFile(join(bridge, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(nestedRepo, ".git"), { recursive: true });
  await writeFile(join(nestedRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, "README.txt"), "ignore me\n");

  try {
    const catalog = new ProjectCatalog(root);
    const projects = await catalog.list();

    assert.deepEqual(
      projects.map((project) => ({ alias: project.alias, ready: project.ready })),
      [
        { alias: "bridge", ready: true },
        { alias: "nested", ready: false },
        { alias: "scratch", ready: false },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectsRootConfig infers a shared parent from legacy project config", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-legacy-root-")));
  const bridge = join(root, "bridge");
  const sage = join(root, "SageTalk");
  mkdirSync(join(bridge, ".git"), { recursive: true });
  mkdirSync(join(sage, ".git"), { recursive: true });
  await writeFile(join(bridge, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(sage, ".git", "HEAD"), "ref: refs/heads/main\n");

  try {
    const resolved = await resolveProjectsRootConfig({
      defaultProject: "SageTalk",
      streamIntervalMs: 10_000,
      extraWritableRoots: [],
      projects: {
        bridge: { cwd: bridge },
        SageTalk: { cwd: sage },
      },
    });

    assert.equal(resolved.projectsRoot, root);
    assert.equal(resolved.defaultProject, "SageTalk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectsRootConfig rejects legacy config that spans multiple parents", async () => {
  const bridge = await makeGitRepo("wcb-bridge-");
  const sage = await makeGitRepo("wcb-sage-");

  try {
    await assert.rejects(
      resolveProjectsRootConfig({
        defaultProject: "bridge",
        streamIntervalMs: 10_000,
        extraWritableRoots: [],
        projects: {
          bridge: { cwd: bridge },
          SageTalk: { cwd: sage },
        },
      }),
      /run npm run setup/i,
    );
  } finally {
    await rm(bridge, { recursive: true, force: true });
    await rm(sage, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused config tests to verify they fail**

Run:

```bash
npx tsx --test tests/projectConfig.test.ts
```

Expected: failure because `ProjectCatalog` and `resolveProjectsRootConfig` do not exist.

- [ ] **Step 3: Replace the static registry with a root-based catalog**

Edit `src/config/projects.ts` so it exposes a dynamic catalog and legacy compatibility helper:

```ts
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

import { assertGitRepo, findGitRoot } from "./git.js";
import { expandHome } from "./security.js";
import type { BridgeConfig } from "./config.js";

export interface ProjectDefinition {
  alias: string;
  cwd: string;
  ready: boolean;
}

export class ProjectCatalog {
  constructor(readonly projectsRoot: string) {}

  async list(): Promise<ProjectDefinition[]> {
    const entries = await readdir(this.projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const cwd = await realpath(resolve(this.projectsRoot, entry.name));
          const gitRoot = await findGitRoot(cwd);
          return { alias: entry.name, cwd, ready: gitRoot === cwd };
        }),
    );
    return projects.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async get(alias: string): Promise<ProjectDefinition | undefined> {
    return (await this.list()).find((project) => project.alias === alias);
  }

  async resolveInitialProject(defaultProject: string, lastProject?: string): Promise<ProjectDefinition> {
    const projects = await this.list();
    const preferred = [lastProject, defaultProject].filter(Boolean) as string[];
    for (const alias of preferred) {
      const project = projects.find((item) => item.alias === alias);
      if (project) return project;
    }
    throw new Error("未找到可用项目，请重新运行 npm run setup");
  }

  async init(alias: string): Promise<ProjectDefinition> {
    const project = await this.get(alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    const result = spawnSync("git", ["init", project.cwd], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git init 失败: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const refreshed = await this.get(alias);
    if (!refreshed?.ready) throw new Error(`git init 未成功初始化项目: ${alias}`);
    return refreshed;
  }
}

export async function resolveProjectsRootConfig(config: BridgeConfig): Promise<{ projectsRoot: string; defaultProject: string }> {
  if (config.projectsRoot) {
    return { projectsRoot: await realpathProjectPath(config.projectsRoot), defaultProject: config.defaultProject };
  }

  const legacyRoots = Object.entries(config.projects ?? {}).map(([, project]) => project.cwd);
  if (legacyRoots.length === 0) {
    throw new Error("未配置 projectsRoot，请运行 npm run setup");
  }

  const resolved = await Promise.all(legacyRoots.map((cwd) => realpathProjectPath(cwd)));
  const parents = [...new Set(resolved.map((cwd) => dirname(cwd)))];
  if (parents.length !== 1) {
    throw new Error("旧配置跨越多个项目根目录，请运行 npm run setup");
  }

  return {
    projectsRoot: parents[0],
    defaultProject: config.defaultProject || basename(resolved[0]),
  };
}

async function realpathProjectPath(inputPath: string): Promise<string> {
  const expanded = expandHome(inputPath.trim());
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded);
  return realpath(absolute);
}
```

Also add the missing import for `spawnSync`:

```ts
import { spawnSync } from "node:child_process";
```

- [ ] **Step 4: Preserve a strict repo-root check for existing explicit config migration**

In the same file, add this helper and call it from `resolveProjectsRootConfig` before accepting legacy project roots:

```ts
async function assertLegacyProjectRoots(projects: Record<string, { cwd: string }>): Promise<void> {
  await Promise.all(
    Object.entries(projects).map(async ([alias, project]) => {
      const cwd = await realpathProjectPath(project.cwd);
      const gitRoot = await assertGitRepo(cwd);
      if (gitRoot !== cwd) {
        throw new Error(`Legacy project ${alias} must stay at a Git repo root: ${cwd}`);
      }
    }),
  );
}
```

Then insert it before `legacyRoots` are mapped:

```ts
  if (config.projects) {
    await assertLegacyProjectRoots(config.projects);
  }
```

- [ ] **Step 5: Re-run the focused config tests**

Run:

```bash
npx tsx --test tests/projectConfig.test.ts
```

Expected: PASS for the new discovery and legacy-inference coverage.

- [ ] **Step 6: Commit**

```bash
git add src/config/projects.ts tests/projectConfig.test.ts
git commit -m "feat: discover projects from projects root"
```

---

### Task 3: Rewrite Setup Around `projectsRoot`

**Files:**
- Create: `src/setup/flow.ts`
- Modify: `src/setup/setup.ts`
- Test: `tests/setupFlow.test.ts`

- [ ] **Step 1: Write failing tests for the setup flow**

Create `tests/setupFlow.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { runSetupFlow } from "../src/setup/flow.js";

test("runSetupFlow saves projectsRoot and defaultProject from discovered children", async () => {
  const prompts = ["/tmp/projects", "2"];
  const saved: unknown[] = [];
  const inits: string[] = [];

  const summary = await runSetupFlow({
    currentConfig: { defaultProject: "bridge", streamIntervalMs: 10_000, extraWritableRoots: [] },
    bindWechat: async () => ({ boundUserId: "user-1" }),
    ask: async () => prompts.shift() ?? "",
    resolveProjectsRoot: async (input) => input,
    discoverProjects: async () => [
      { alias: "bridge", cwd: "/tmp/projects/bridge", ready: true },
      { alias: "SageTalk", cwd: "/tmp/projects/SageTalk", ready: true },
    ],
    saveConfig: (config) => { saved.push(config); },
    initGitRepo: async (cwd) => { inits.push(cwd); },
  });

  assert.deepEqual(saved, [{ projectsRoot: "/tmp/projects", defaultProject: "SageTalk", streamIntervalMs: 10_000 }]);
  assert.deepEqual(inits, []);
  assert.match(summary, /\/project/);
  assert.match(summary, /@ProjectName/);
});

test("runSetupFlow confirms git init when the chosen default project is not a repo", async () => {
  const prompts = ["/tmp/projects", "1", "y"];
  const inits: string[] = [];

  await runSetupFlow({
    currentConfig: { defaultProject: "scratch", streamIntervalMs: 5_000, extraWritableRoots: [] },
    bindWechat: async () => ({ boundUserId: "user-1" }),
    ask: async () => prompts.shift() ?? "",
    resolveProjectsRoot: async (input) => input,
    discoverProjects: async () => [{ alias: "scratch", cwd: "/tmp/projects/scratch", ready: false }],
    saveConfig: () => {},
    initGitRepo: async (cwd) => { inits.push(cwd); },
  });

  assert.deepEqual(inits, ["/tmp/projects/scratch"]);
});
```

- [ ] **Step 2: Run the focused setup tests to verify they fail**

Run:

```bash
npx tsx --test tests/setupFlow.test.ts
```

Expected: failure because `src/setup/flow.ts` does not exist.

- [ ] **Step 3: Create a testable setup orchestration**

Create `src/setup/flow.ts`:

```ts
import type { BridgeConfig } from "../config/config.js";
import type { ProjectDefinition } from "../config/projects.js";

export interface SetupFlowDependencies {
  currentConfig: Pick<BridgeConfig, "defaultProject" | "streamIntervalMs" | "extraWritableRoots">;
  bindWechat: () => Promise<{ boundUserId: string }>;
  ask: (prompt: string) => Promise<string>;
  resolveProjectsRoot: (input: string) => Promise<string>;
  discoverProjects: (projectsRoot: string) => Promise<ProjectDefinition[]>;
  saveConfig: (config: Pick<BridgeConfig, "projectsRoot" | "defaultProject" | "streamIntervalMs">) => void;
  initGitRepo: (cwd: string) => Promise<void>;
}

export async function runSetupFlow(deps: SetupFlowDependencies): Promise<string> {
  const account = await deps.bindWechat();
  const projectsRootInput = (await deps.ask("项目根目录 [/Users/you/.codex/projects]: ")).trim() || "~/.codex/projects";
  const projectsRoot = await deps.resolveProjectsRoot(projectsRootInput);
  const projects = await deps.discoverProjects(projectsRoot);
  if (projects.length === 0) {
    throw new Error("项目根目录下没有可用子目录，请先放入项目或重新选择目录。");
  }

  const lines = projects.map((project, index) => `${index + 1}. ${project.alias}${project.ready ? "" : " (未初始化)"}`);
  const indexInput = await deps.ask(`选择默认项目:\\n${lines.join("\\n")}\\n> `);
  const selectedIndex = Number.parseInt(indexInput, 10) - 1;
  const selected = projects[selectedIndex];
  if (!selected) {
    throw new Error("默认项目选择无效。");
  }

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

  return `配置已保存。运行 npm run start 或 npm run daemon -- start。微信里先发 /project，也可以用 @ProjectName ... 定向到某个项目。绑定用户: ${account.boundUserId}`;
}
```

- [ ] **Step 4: Make `runSetup()` a thin CLI wrapper**

Edit `src/setup/setup.ts` so it delegates orchestration to `runSetupFlow`:

```ts
import { runSetupFlow } from "./flow.js";
import { ProjectCatalog, resolveProjectsRootConfig } from "../config/projects.js";
```

Then replace the readline/config section in `runSetup()` with:

```ts
  const rl = createInterface({ input, output });
  try {
    const current = loadConfig();
    const message = await runSetupFlow({
      currentConfig: current,
      bindWechat: async () => {
        const account = await bindWechat();
        saveAccount(account);
        console.log(`微信绑定成功，bound user id: ${account.boundUserId}`);
        return { boundUserId: account.boundUserId };
      },
      ask: (prompt) => rl.question(prompt),
      resolveProjectsRoot: async (projectsRootInput) =>
        (await resolveProjectsRootConfig({ ...current, projectsRoot: projectsRootInput })).projectsRoot,
      discoverProjects: async (projectsRoot) => new ProjectCatalog(projectsRoot).list(),
      saveConfig,
      initGitRepo: async (cwd) => {
        const result = spawnSync("git", ["init", cwd], { encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(`git init 失败: ${result.stderr.trim() || result.stdout.trim()}`);
        }
      },
    });
    console.log(message);
  } finally {
    rl.close();
  }
```

- [ ] **Step 5: Re-run the setup tests**

Run:

```bash
npx tsx --test tests/setupFlow.test.ts
```

Expected: PASS for the new flow tests.

- [ ] **Step 6: Commit**

```bash
git add src/setup/flow.ts src/setup/setup.ts tests/setupFlow.test.ts
git commit -m "feat: rewrite setup for projects root onboarding"
```

---

### Task 4: Refresh Project Resolution At Runtime And Remember `lastProject`

**Files:**
- Modify: `src/core/ProjectRuntimeManager.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/projectRuntime.test.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write failing runtime-manager tests**

Add these tests to `tests/projectRuntime.test.ts` after the helper definitions:

```ts
class MemoryProjectCatalog {
  constructor(public projects: ProjectDefinition[]) {}
  readonly initialized: string[] = [];

  async list(): Promise<ProjectDefinition[]> {
    return this.projects.map((project) => ({ ...project }));
  }

  async get(alias: string): Promise<ProjectDefinition | undefined> {
    return this.projects.find((project) => project.alias === alias);
  }

  async resolveInitialProject(defaultProject: string, lastProject?: string): Promise<ProjectDefinition> {
    return (await this.get(lastProject ?? "")) ?? (await this.get(defaultProject))!;
  }

  async init(alias: string): Promise<ProjectDefinition> {
    const project = this.projects.find((item) => item.alias === alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    project.ready = true;
    this.initialized.push(alias);
    return { ...project };
  }
}

test("setActiveProject persists the selected project name", async () => {
  const catalog = new MemoryProjectCatalog([
    { alias: "bridge", cwd: "/tmp/bridge", ready: true },
    { alias: "SageTalk", cwd: "/tmp/sage", ready: true },
  ]);
  const remembered: string[] = [];
  const { backend, store, sender } = makeManager();
  const manager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: store as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 0,
    extraWritableRoots: [],
    initialProjectAlias: "bridge",
    defaultProjectAlias: "bridge",
    rememberActiveProject: async (alias) => { remembered.push(alias); },
  });

  await manager.setActiveProject("SageTalk");

  assert.equal(manager.activeProjectAlias, "SageTalk");
  assert.deepEqual(remembered, ["SageTalk"]);
});

test("listProjects reflects newly added child directories without restarting the manager", async () => {
  const catalog = new MemoryProjectCatalog([{ alias: "bridge", cwd: "/tmp/bridge", ready: true }]);
  const { backend, store, sender } = makeManager();
  const manager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: store as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 0,
    extraWritableRoots: [],
    initialProjectAlias: "bridge",
    defaultProjectAlias: "bridge",
  });

  assert.deepEqual((await manager.listProjects()).map((project) => project.alias), ["bridge"]);

  catalog.projects.push({ alias: "SageTalk", cwd: "/tmp/sage", ready: true });

  assert.deepEqual((await manager.listProjects()).map((project) => project.alias), ["bridge", "SageTalk"]);
});

test("missing active project falls back to the configured default project", async () => {
  const catalog = new MemoryProjectCatalog([
    { alias: "bridge", cwd: "/tmp/bridge", ready: true },
    { alias: "SageTalk", cwd: "/tmp/sage", ready: true },
  ]);
  const remembered: string[] = [];
  const { backend, store, sender } = makeManager();
  const manager = new ProjectRuntimeManager({
    account,
    catalog,
    sessionStore: store as unknown as ProjectSessionStore,
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 0,
    extraWritableRoots: [],
    initialProjectAlias: "deleted-project",
    defaultProjectAlias: "bridge",
    rememberActiveProject: async (alias) => { remembered.push(alias); },
  });

  const session = await manager.session();

  assert.equal(session.projectAlias, "bridge");
  assert.equal(manager.activeProjectAlias, "bridge");
  assert.deepEqual(remembered, ["bridge"]);
});
```

Add this test to `tests/bridge.test.ts` near the runtime bootstrap coverage:

```ts
test("buildProjectBridgeRuntime restores lastProject when it still exists", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-")));
  const bridgeDir = join(root, "bridge");
  const sageDir = join(root, "SageTalk");
  mkdirSync(join(bridgeDir, ".git"), { recursive: true });
  mkdirSync(join(sageDir, ".git"), { recursive: true });
  await writeFile(join(bridgeDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(sageDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  try {
    const { projectManager } = await buildProjectBridgeRuntime({
      account,
      config: { projectsRoot: root, defaultProject: "bridge", streamIntervalMs: 1, extraWritableRoots: [] },
      sender: new FakeSender(),
      backend: new FakeBackend(),
      loadRuntimeState: () => ({ lastProject: "SageTalk" }),
      saveRuntimeState: () => {},
    });

    assert.equal(projectManager.activeProjectAlias, "SageTalk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused runtime tests to verify they fail**

Run:

```bash
npx tsx --test tests/projectRuntime.test.ts tests/bridge.test.ts
```

Expected: failure because `ProjectRuntimeManager` still expects a static registry and `buildProjectBridgeRuntime()` cannot load runtime state.

- [ ] **Step 3: Refactor `ProjectRuntimeManager` around the dynamic catalog**

Edit `src/core/ProjectRuntimeManager.ts`:

```ts
import type { ProjectCatalog, ProjectDefinition } from "../config/projects.js";

export interface ProjectRuntimeManagerOptions {
  account: Pick<AccountData, "boundUserId">;
  catalog: ProjectCatalog;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots?: string[];
  initialProjectAlias: string;
  defaultProjectAlias: string;
  rememberActiveProject?: (alias: string) => Promise<void> | void;
}
```

Update the class fields and constructor:

```ts
  private readonly catalog: ProjectCatalog;
  private readonly defaultProjectAlias: string;
  private readonly rememberActiveProject?: (alias: string) => Promise<void> | void;

  constructor(options: ProjectRuntimeManagerOptions) {
    this.account = options.account;
    this.catalog = options.catalog;
    this.sessionStore = options.sessionStore;
    this.sender = options.sender;
    this.agentService = options.agentService;
    this.streamIntervalMs = options.streamIntervalMs;
    this.extraWritableRoots = options.extraWritableRoots ?? [];
    this.activeAlias = options.initialProjectAlias;
    this.defaultProjectAlias = options.defaultProjectAlias;
    this.rememberActiveProject = options.rememberActiveProject;
  }
```

Add the custom non-Git guard near the top of the file:

```ts
export class ProjectInitRequiredError extends Error {
  constructor(readonly projectAlias: string) {
    super(`Project requires git init: ${projectAlias}`);
  }
}
```

Then change the list/set/resolve methods to async and add fallback/init support:

```ts
  async initializeProject(alias: string): Promise<ProjectDefinition> {
    const project = await this.catalog.init(alias);
    this.activeAlias = project.alias;
    await this.rememberActiveProject?.(project.alias);
    return project;
  }

  async listProjects(): Promise<ProjectListEntry[]> {
    const projects = await this.catalog.list();
    return projects.map((project) => ({ ...project, active: project.alias === this.activeAlias }));
  }

  async setActiveProject(alias: string): Promise<ProjectDefinition> {
    const project = await this.requireProject(alias);
    this.activeAlias = project.alias;
    await this.rememberActiveProject?.(project.alias);
    return project;
  }

  private async requireProject(alias?: string): Promise<ProjectDefinition> {
    const requestedAlias = alias ?? this.activeAlias;
    const project = await this.catalog.get(requestedAlias);
    if (project) {
      return project;
    }
    if (alias) {
      throw new Error(`Unknown project: ${alias}`);
    }
    const fallback = await this.catalog.resolveInitialProject(this.defaultProjectAlias);
    this.activeAlias = fallback.alias;
    await this.rememberActiveProject?.(fallback.alias);
    return fallback;
  }

  private async requireRunnableProject(alias?: string): Promise<ProjectDefinition> {
    const project = await this.requireProject(alias);
    if (!project.ready) {
      throw new ProjectInitRequiredError(project.alias);
    }
    return project;
  }
```

Update `runtime()` and every method that used the old registry to await `requireRunnableProject()` before creating/looking up a runtime. Leave `listProjects()` and `initializeProject()` on the non-runtime path so non-Git children can still be displayed and initialized.

- [ ] **Step 4: Load and persist `lastProject` during bridge bootstrap**

Edit `src/runtime/bridge.ts` so the runtime is seeded from the new catalog plus runtime state:

```ts
import { loadRuntimeState, saveRuntimeState, type BridgeRuntimeState } from "../config/runtimeState.js";
import { ProjectCatalog, resolveProjectsRootConfig } from "../config/projects.js";
```

Expand `BuildProjectBridgeRuntimeOptions`:

```ts
  loadRuntimeState?: () => BridgeRuntimeState;
  saveRuntimeState?: (state: BridgeRuntimeState) => void;
```

Then update `buildProjectBridgeRuntime()`:

```ts
  const resolvedConfig = await resolveProjectsRootConfig(options.config);
  const catalog = new ProjectCatalog(resolvedConfig.projectsRoot);
  const runtimeState = options.loadRuntimeState?.() ?? loadRuntimeState();
  const initialProject = await catalog.resolveInitialProject(resolvedConfig.defaultProject, runtimeState.lastProject);
  const extraWritableRoots = await Promise.all(options.config.extraWritableRoots.map((root) => realpath(root)));

  const projectManager = new ProjectRuntimeManager({
    account: options.account,
    catalog,
    sessionStore: projectSessionStore,
    sender: options.sender,
    agentService,
    streamIntervalMs: options.config.streamIntervalMs,
    extraWritableRoots,
    initialProjectAlias: initialProject.alias,
    defaultProjectAlias: resolvedConfig.defaultProject,
    rememberActiveProject: async (alias) => (options.saveRuntimeState ?? saveRuntimeState)({ lastProject: alias }),
  });
```

- [ ] **Step 5: Re-run the focused runtime tests**

Run:

```bash
npx tsx --test tests/projectRuntime.test.ts tests/bridge.test.ts
```

Expected: PASS for the new dynamic-listing and last-project bootstrap coverage.

- [ ] **Step 6: Commit**

```bash
git add src/core/ProjectRuntimeManager.ts src/runtime/bridge.ts tests/projectRuntime.test.ts tests/bridge.test.ts
git commit -m "feat: remember active project from projects root"
```

---

### Task 5: Simplify Commands, Add Detailed Help, And Gate Non-Git Projects

**Files:**
- Create: `src/commands/helpCatalog.ts`
- Modify: `src/commands/router.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/core/BridgeService.ts`
- Test: `tests/commands.test.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write failing command/help tests**

Add these tests to `tests/commands.test.ts`:

```ts
test("/help shows only the streamlined overview", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({ text: "/help", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /\/project/);
  assert.match(result.reply ?? "", /\/replace/);
  assert.doesNotMatch(result.reply ?? "", /\/cwd/);
});

test("/help project shows detailed syntax and explicit init guidance", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({ text: "/help project", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /\/project <name>/);
  assert.match(result.reply ?? "", /--init/);
  assert.match(result.reply ?? "", /是否会切换当前项目/);
});

test("/project requires explicit --init before switching to a non-git child", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.addProject("scratch", "/tmp/scratch", false);

  const blocked = await routeCommand({ text: "/project scratch", projectManager, boundUserId: "user-1" });
  const confirmed = await routeCommand({ text: "/project scratch --init", projectManager, boundUserId: "user-1" });

  assert.match(blocked.reply ?? "", /\/project scratch --init/);
  assert.equal(projectManager.initialized, ["scratch"]);
  assert.equal(projectManager.activeProjectAlias, "scratch");
  assert.match(confirmed.reply ?? "", /当前项目已切换为: scratch/);
});
```

Extend `FakeProjectManager` in the same test file:

```ts
  initialized: string[] = [];

  addProject(alias: string, cwd: string, ready = true): void {
    this.sessions.set(alias, this.createProjectSession(alias, cwd));
    this.ready.set(alias, ready);
  }

  readonly ready = new Map<string, boolean>([
    ["bridge", true],
    ["SageTalk", true],
  ]);

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return Array.from(this.sessions.keys()).map((alias) => ({
      alias,
      cwd: this.sessions.get(alias)!.cwd,
      ready: this.ready.get(alias) ?? true,
      active: alias === this.activeProjectAlias,
    }));
  }

  async initializeProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    this.assertProject(alias);
    this.ready.set(alias, true);
    this.initialized.push(alias);
    const session = this.sessions.get(alias)!;
    this.activeProjectAlias = alias;
    return { alias, cwd: session.cwd, ready: true };
  }
```

Add this test to `tests/bridge.test.ts`:

```ts
test("targeted prompt to a non-git child returns explicit init guidance", async () => {
  const sender = new FakeSender();
  const projectManager = {
    activeProjectAlias: "bridge",
    listProjects: async () => [
      { alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true },
      { alias: "scratch", cwd: "/tmp/scratch", ready: false, active: false },
    ],
    runPrompt: async () => { throw new Error("should not run"); },
  };
  const service = new BridgeService({ account, projectManager: projectManager as never, sender });

  await service.handleMessage(textMessage("user-1", "@scratch run tests"));

  assert.match(sender.messages.join("\n"), /\/project scratch --init/);
});
```

- [ ] **Step 2: Run the focused command tests to verify they fail**

Run:

```bash
npx tsx --test tests/commands.test.ts tests/bridge.test.ts
```

Expected: failure because help detail, async project lists, and `--init` do not exist.

- [ ] **Step 3: Create a single command-help catalog**

Create `src/commands/helpCatalog.ts`:

```ts
export interface CommandHelpEntry {
  name: string;
  summary: string;
  syntax: string[];
  core: boolean;
  changesProject: boolean;
  interruptsRunningWork: boolean;
  examples: string[];
  notes: string[];
}

export const COMMAND_HELP: CommandHelpEntry[] = [
  {
    name: "project",
    summary: "查看项目列表，或切换当前项目",
    syntax: ["/project", "/project <name>", "/project <name> --init"],
    core: true,
    changesProject: true,
    interruptsRunningWork: false,
    examples: ["/project", "/project SageTalk", "/project scratch --init"],
    notes: ["项目名来自 projectsRoot 下的一级子目录名。", "非 Git 目录需要显式使用 --init。"],
  },
  {
    name: "replace",
    summary: "中断当前或指定项目，并立即执行新的 prompt",
    syntax: ["/replace <prompt>", "/replace <project> <prompt>"],
    core: true,
    changesProject: false,
    interruptsRunningWork: true,
    examples: ["/replace 重新跑测试", "/replace SageTalk 重新按这个方案实现"],
    notes: ["不带项目名时作用于当前项目。"],
  },
];

export function formatHelpOverview(): string {
  return [
    "常用命令:",
    ...COMMAND_HELP.filter((entry) => entry.core).map((entry) => `/${entry.name.padEnd(10, " ")} ${entry.summary}`),
    "",
    "发送 /help <command> 查看详细说明。",
  ].join("\n");
}

export function formatHelpDetail(name: string): string | undefined {
  const entry = COMMAND_HELP.find((item) => item.name === name);
  if (!entry) return undefined;
  return [
    `命令: /${entry.name}`,
    `作用: ${entry.summary}`,
    `语法: ${entry.syntax.join(" | ")}`,
    `是否会切换当前项目: ${entry.changesProject ? "会" : "不会"}`,
    `是否会中断当前任务: ${entry.interruptsRunningWork ? "会" : "不会"}`,
    `示例: ${entry.examples.join(" | ")}`,
    `注意事项: ${entry.notes.join(" ")}`,
  ].join("\n");
}
```

Continue the same `CommandHelpEntry` shape for `/status`, `/interrupt`, `/history`, `/mode`, `/model`, and `/cwd` so `/help <command>` and `docs/commands.md` stay in sync.

- [ ] **Step 4: Refactor the handlers for async project lists and explicit init**

Edit `src/commands/router.ts`:

```ts
      case "help":
        return await handleHelp(args);
```

Edit `src/commands/handlers.ts`:

```ts
import { formatHelpDetail, formatHelpOverview } from "./helpCatalog.js";
```

Update the command manager shape and help handler:

```ts
export type CommandProjectManager = Pick<
  ProjectRuntimeManager,
  | "activeProjectAlias"
  | "listProjects"
  | "setActiveProject"
  | "initializeProject"
  | "interrupt"
  | "replacePrompt"
  | "clear"
  | "setMode"
  | "setModel"
  | "session"
>;

export async function handleHelp(args = ""): Promise<CommandResult> {
  const target = args.trim().toLowerCase();
  if (!target) {
    return { handled: true, reply: formatHelpOverview() };
  }
  const detail = formatHelpDetail(target);
  return { handled: true, reply: detail ?? `未知命令: ${target}\n输入 /help 查看可用命令。` };
}
```

Add this helper in the same file and reuse it wherever a non-Git project is blocked:

```ts
function formatProjectInitReply(alias: string): string {
  return `项目 ${alias} 还不是 Git 仓库。发送 /project ${alias} --init 初始化并切换。`;
}
```

Change project handling to require explicit `--init`:

```ts
export async function handleProject(ctx: CommandContext, args: string): Promise<CommandResult> {
  const manager = requireProjectManager(ctx);
  const trimmed = args.trim();
  if (!trimmed) {
    return { handled: true, reply: formatProjectList(await manager.listProjects(), manager.activeProjectAlias) };
  }

  const init = trimmed.endsWith(" --init");
  const alias = init ? trimmed.slice(0, -7).trim() : trimmed;
  const project = (await manager.listProjects()).find((item) => item.alias === alias);
  if (!project) {
    return unknownProject(alias, await manager.listProjects());
  }
  if (!project.ready && !init) {
    return { handled: true, reply: formatProjectInitReply(alias) };
  }
  const switched = project.ready ? await manager.setActiveProject(alias) : await manager.initializeProject(alias);
  return { handled: true, reply: `当前项目已切换为: ${switched.alias}\n工作目录: ${switched.cwd}` };
}
```

Before dispatching `/replace`, add the same readiness guard:

```ts
  const targetAlias = parsed.alias ?? manager.activeProjectAlias;
  const project = (await manager.listProjects()).find((item) => item.alias === targetAlias);
  if (project && !project.ready) {
    return { handled: true, reply: formatProjectInitReply(project.alias) };
  }
```

Use the same project list in `/cwd` and `unknownProject()`:

```ts
function formatProjectList(projects: Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>, activeAlias: string): string {
  return [
    "项目列表:",
    ...projects.map((project) => `${project.active ? "*" : " "} ${project.alias} - ${project.cwd}${project.ready ? "" : " (未初始化)"}`),
    `当前项目: ${activeAlias}`,
  ].join("\n");
}
```

- [ ] **Step 5: Block targeted prompts from non-Git children**

Edit `src/core/BridgeService.ts` so targeted prompt checks await the project list and return the same init guidance:

```ts
function formatProjectInitReply(alias: string): string {
  return `项目 ${alias} 还不是 Git 仓库。发送 /project ${alias} --init 初始化并切换。`;
}

  const projects = await this.projectManager.listProjects();
  const targeted = parseTargetedPrompt(rawText);
  const activeProject = projects.find((item) => item.alias === this.projectManager.activeProjectAlias);
  if (!targeted && activeProject && !activeProject.ready) {
    await this.sender.sendText(fromUserId, contextToken, formatProjectInitReply(activeProject.alias));
    return;
  }
  if (targeted) {
    const project = projects.find((item) => item.alias === targeted.projectAlias);
    if (!project) {
      await this.sender.sendText(fromUserId, contextToken, formatUnknownProjectReply(projects, targeted.projectAlias));
      return;
    }
    if (!project.ready) {
      await this.sender.sendText(fromUserId, contextToken, formatProjectInitReply(project.alias));
      return;
    }
  }
```

Adjust the helper signatures accordingly:

```ts
function formatUnknownProjectReply(projects: Array<{ alias: string }>, alias: string): string {
  return `未知项目: ${alias}\n可用项目: ${projects.map((project) => project.alias).join(", ")}`;
}
```

- [ ] **Step 6: Re-run the focused command tests**

Run:

```bash
npx tsx --test tests/commands.test.ts tests/bridge.test.ts
```

Expected: PASS for the new help and init-gating behavior.

- [ ] **Step 7: Commit**

```bash
git add src/commands/helpCatalog.ts src/commands/router.ts src/commands/handlers.ts src/core/BridgeService.ts tests/commands.test.ts tests/bridge.test.ts
git commit -m "feat: streamline command help and project switching"
```

---

### Task 6: Rewrite The README And Add A Full Command Reference

**Files:**
- Create: `docs/commands.md`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `README_ES.md`
- Modify: `README_JA.md`
- Modify: `README_KO.md`

- [ ] **Step 1: Create the full command reference**

Create `docs/commands.md` with one section per command, using the same structure as `src/commands/helpCatalog.ts`. Start the document with:

```md
# Command Reference

## /project

- 作用：查看项目列表，或切换当前项目
- 语法：`/project`、`/project <name>`、`/project <name> --init`
- 是否会切换当前项目：会
- 是否会中断当前任务：不会
- 示例：`/project`、`/project SageTalk`、`/project scratch --init`
- 注意事项：项目名来自 `projectsRoot` 下的一级子目录名；非 Git 目录需要显式 `--init`

## /replace

- 作用：中断当前或指定项目，并立即执行新的 prompt
- 语法：`/replace <prompt>`、`/replace <project> <prompt>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：会
- 示例：`/replace 重新跑测试`、`/replace SageTalk 重新按这个方案实现`
- 注意事项：不带项目名时作用于当前项目
```

Continue the same format for `/status`, `/interrupt`, `/history`, `/mode`, `/model`, and `/cwd`.

- [ ] **Step 2: Rewrite the top of `README.md` around the shortest path**

Replace the current install/commands opening with these sections:

````md
## 3 分钟上手

```bash
npm install
npm run setup
npm run start
```

`setup` 会完成三件事：

1. 检查本机 Codex 登录
2. 绑定微信
3. 选择项目根目录和默认项目

## 微信里怎么用

```text
/project
/project SageTalk
@SageTalk 帮我看一下测试失败原因
```

不带 `@项目名` 的普通消息，会发给当前项目。

## 项目目录规则

- 只读取 `projectsRoot` 下的一级子目录
- 新项目放进去后就能在 `/project` 里看到
- 非 Git 目录第一次使用时，需要显式发送 `/project <name> --init`
````

Keep `/cwd` only in a later “高级/兼容用法” section, not in the homepage command list.

- [ ] **Step 3: Mirror the simplified onboarding in the translated READMEs**

Apply the same structural changes to `README_EN.md`, `README_ES.md`, `README_JA.md`, and `README_KO.md`. Each translated file should:

````md
## Quick Start

```bash
npm install
npm run setup
npm run start
```

Setup checks Codex login, binds WeChat, and asks for the project root plus default project.

## Everyday WeChat Usage

```text
/project
/project SageTalk
@SageTalk run tests and summarize failures
```

See [docs/commands.md](docs/commands.md) for the full command reference.
````

Do not reintroduce `defaultCwd`, `allowlistRoots`, or `/cwd` into the translated homepage sections.

- [ ] **Step 4: Run repo-wide verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: both commands PASS after the config, setup, runtime, command, and documentation updates land.

- [ ] **Step 5: Commit**

```bash
git add docs/commands.md README.md README_EN.md README_ES.md README_JA.md README_KO.md
git commit -m "docs: simplify projects root onboarding"
```

---

## Self-Review Checklist

- Spec coverage:
  - `projectsRoot` config and `defaultProject`: Task 1 and Task 2
  - first-level child discovery and non-recursive rules: Task 2
  - first-time setup and optional `git init`: Task 3
  - remember `lastProject`: Task 1 and Task 4
  - streamlined command surface and `/help <command>`: Task 5
  - concise README plus full command reference: Task 6
- Placeholder scan: no `TODO`, `TBD`, or “similar to above” instructions remain.
- Type consistency:
  - `ProjectDefinition` carries `alias`, `cwd`, and `ready` everywhere.
  - `ProjectRuntimeManager.listProjects()` is async after Task 4 and Task 5 updates all call sites accordingly.
  - `ProjectRuntimeManager.initializeProject()` and `formatProjectInitReply()` keep non-Git handling consistent across setup, commands, and chat routing.
  - `saveConfig()` writes the new minimal config shape after Task 1 and Task 3.
