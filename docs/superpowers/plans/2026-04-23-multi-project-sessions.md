# Multi-Project Codex Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit project aliases so one WeChat bridge can run independent, concurrent Codex sessions for repositories such as `bridge` and `SageTalk`.

**Architecture:** Introduce project-aware config, registry, session storage, and runtime units. Keep Codex execution behind `AgentService`, but add a per-project execution key so concurrent project tasks do not interrupt or overwrite each other. Move WeChat command and prompt routing to a project runtime manager while preserving legacy `/cwd` and MCP compatibility.

**Tech Stack:** TypeScript, Node.js `node:test`, existing Codex CLI backend, stdio MCP tools, secure JSON storage under `~/.wechat-agent-bridge`.

---

## File Structure

- Modify `src/backend/AgentBackend.ts`: add optional `executionKey` to agent requests.
- Modify `src/backend/CodexExecBackend.ts`: key child processes by `executionKey ?? userId`.
- Modify `src/core/AgentService.ts`: pass execution keys through interrupt/run calls.
- Modify `tests/codexBackend.test.ts`: prove two projects use separate execution keys.
- Modify `src/config/config.ts`: add new `defaultProject` and `projects` fields while retaining legacy fields.
- Create `src/config/projects.ts`: validate aliases, resolve project cwd realpaths, derive legacy project config.
- Modify `src/runtime/preflight.ts`: validate all configured projects.
- Create `tests/projectConfig.test.ts`: cover new config normalization and validation.
- Modify `src/session/types.ts`: add `ProjectSession` and project session defaults.
- Create `src/session/projectSessionStore.ts`: store sessions at `sessions/<userId>/<projectAlias>.json`.
- Create `tests/projectSessionStore.test.ts`: cover per-user, per-project isolation and stale reset.
- Create `src/core/ProjectRuntime.ts`: own one project turn, busy rejection, interrupt, replace, active/background output policy.
- Create `src/core/ProjectRuntimeManager.ts`: track active project and route project commands/prompts.
- Create `tests/projectRuntime.test.ts`: cover concurrency, busy rejection, replace, and output policy.
- Modify `src/commands/router.ts` and `src/commands/handlers.ts`: add project-aware command support or delegate to `ProjectRuntimeManager`.
- Modify `tests/commands.test.ts`: cover `/project`, `/interrupt`, `/replace`, project-aware `/status`, `/history`, `/mode`, `/model`, `/clear`, and `/cwd` compatibility.
- Modify `src/core/BridgeService.ts`: route ordinary messages, `@Project` prompts, and commands through project runtime.
- Modify `src/runtime/bridge.ts`: build registry/session store/runtime manager for daemon startup and tests.
- Modify `tests/bridge.test.ts` and `tests/coreServices.test.ts`: update old interrupt-on-new-message expectations to busy rejection for same project.
- Modify `src/mcp/context.ts` and `src/mcp/tools/*.ts`: add optional `project` argument support through project runtime.
- Modify `tests/mcpTools.test.ts`: cover project-aware MCP calls and backward-compatible defaults.
- Modify `src/setup/setup.ts`: write explicit project config for the default project.
- Modify `README.md`, `README_EN.md`, `README_ES.md`, `README_JA.md`, `README_KO.md`, and `docs/mcp.md`: document project config, commands, and MCP project args.

---

### Task 1: Add Per-Project Execution Keys To Agent Backend

**Files:**
- Modify: `src/backend/AgentBackend.ts`
- Modify: `src/backend/CodexExecBackend.ts`
- Modify: `src/core/AgentService.ts`
- Test: `tests/codexBackend.test.ts`

- [ ] **Step 1: Write failing tests for separate execution keys**

Add this test to `tests/codexBackend.test.ts` near the argument tests:

```ts
test("AgentTurnRequest can carry a per-project execution key", () => {
  const request = {
    userId: "user-1",
    executionKey: "user-1:SageTalk",
    prompt: "hi",
    cwd: "/tmp/SageTalk",
    mode: "readonly" as const,
  };

  assert.equal(request.executionKey, "user-1:SageTalk");
  assert.deepEqual(
    buildCodexExecArgs(request),
    ["--sandbox", "read-only", "--ask-for-approval", "never", "--cd", "/tmp/SageTalk", "exec", "--json", "hi"],
  );
});
```

Add this fake-key test in `tests/coreServices.test.ts` after the AgentService fallback test:

```ts
test("AgentService interrupts by execution key", async () => {
  const backend = new FakeBackend();
  const service = new AgentService(backend);

  await service.interrupt("user-1:SageTalk");

  assert.deepEqual(backend.interrupts, ["user-1:SageTalk"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test
```

Expected: TypeScript test execution fails because `executionKey` is not part of `AgentTurnRequest`, or the new AgentService test fails if the fake backend type is not updated.

- [ ] **Step 3: Update backend request types**

Edit `src/backend/AgentBackend.ts`:

```ts
export interface AgentTurnRequest {
  userId: string;
  executionKey?: string;
  prompt: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  codexSessionId?: string;
  extraWritableRoots?: string[];
}
```

Keep `AgentBackend.interrupt(userId: string)` parameter name as a generic key by changing the name only:

```ts
interrupt(executionKey: string): Promise<void>;
```

- [ ] **Step 4: Key Codex children by execution key**

Edit `src/backend/CodexExecBackend.ts` inside the class:

```ts
  async interrupt(executionKey: string): Promise<void> {
    const child = this.children.get(executionKey);
    if (!child) return;
    await interruptChildProcess(child, this.interruptTimeoutMs);
    this.children.delete(executionKey);
  }
```

Then update `runTurn`:

```ts
    const executionKey = request.executionKey ?? request.userId;
    const child = spawn(this.codexBin, args, {
      cwd: request.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(executionKey, child);
```

And the close handler:

```ts
      child.on("close", (code, signal) => {
        this.children.delete(executionKey);
        if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGKILL") interrupted = true;
        if (code && !interrupted) {
          reject(new Error(`codex exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        resolve({ text, codexSessionId, codexThreadId, interrupted });
      });
```

- [ ] **Step 5: Update AgentService naming**

Edit `src/core/AgentService.ts`:

```ts
  async interrupt(executionKey: string): Promise<void> {
    await this.backend.interrupt(executionKey);
  }
```

No run-turn behavior changes are needed; `executionKey` passes through inside the existing request object.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test
```

Expected: all existing tests pass, including the new execution-key assertions.

- [ ] **Step 7: Commit**

```bash
git add src/backend/AgentBackend.ts src/backend/CodexExecBackend.ts src/core/AgentService.ts tests/codexBackend.test.ts tests/coreServices.test.ts
git commit -m "feat: key agent turns by project"
```

---

### Task 2: Add Project Config And Registry

**Files:**
- Modify: `src/config/config.ts`
- Create: `src/config/projects.ts`
- Modify: `src/runtime/preflight.ts`
- Test: `tests/projectConfig.test.ts`

- [ ] **Step 1: Write failing project config tests**

Create `tests/projectConfig.test.ts`:

```ts
import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createLegacyProjects, resolveProjectRegistry, validateProjectAlias } from "../src/config/projects.js";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

test("validateProjectAlias accepts safe aliases and rejects path-like aliases", () => {
  assert.equal(validateProjectAlias("SageTalk"), "SageTalk");
  assert.equal(validateProjectAlias("bridge-main"), "bridge-main");
  assert.throws(() => validateProjectAlias("../escape"), /Invalid project alias/);
  assert.throws(() => validateProjectAlias("bad name"), /Invalid project alias/);
});

test("resolveProjectRegistry validates explicit projects and default project", async () => {
  const bridge = await makeGitRepo("wcb-bridge-");
  const sage = await makeGitRepo("wcb-sage-");

  const registry = await resolveProjectRegistry({
    defaultProject: "bridge",
    projects: {
      bridge: { cwd: bridge },
      SageTalk: { cwd: sage },
    },
  });

  assert.equal(registry.defaultProject.alias, "bridge");
  assert.equal(registry.get("SageTalk").cwd, sage);
  assert.equal(registry.findByCwd(sage)?.alias, "SageTalk");

  await rm(bridge, { recursive: true, force: true });
  await rm(sage, { recursive: true, force: true });
});

test("createLegacyProjects derives aliases from allowlist roots", () => {
  const projects = createLegacyProjects("/tmp/wechat-agent-bridge", ["/tmp/wechat-agent-bridge", "/tmp/SageTalk"]);

  assert.equal(projects.defaultProject, basename("/tmp/wechat-agent-bridge"));
  assert.equal(projects.projects["wechat-agent-bridge"].cwd, "/tmp/wechat-agent-bridge");
  assert.equal(projects.projects.SageTalk.cwd, "/tmp/SageTalk");
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: fails because `src/config/projects.ts` does not exist.

- [ ] **Step 3: Extend config types**

Edit `src/config/config.ts` to include new fields while preserving old ones:

```ts
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
```

Update `loadConfig()`:

```ts
export function loadConfig(): BridgeConfig {
  const cwd = safeRealpath(process.cwd());
  const config = loadSecureJson<Partial<BridgeConfig>>(getConfigPath(), {});
  const defaultCwd = config.defaultCwd ?? cwd;
  const allowlistRoots = config.allowlistRoots?.length ? config.allowlistRoots : [defaultCwd];
  const projects = config.projects && Object.keys(config.projects).length > 0
    ? config.projects
    : Object.fromEntries(
      allowlistRoots.map((root) => {
        const alias = root.split(/[\\/]/).filter(Boolean).at(-1) ?? "default";
        return [alias, { cwd: root }];
      }),
    );
  const defaultProject = config.defaultProject ?? Object.entries(projects).find(([, project]) => project.cwd === defaultCwd)?.[0] ?? Object.keys(projects)[0] ?? "default";

  return {
    defaultCwd,
    allowlistRoots,
    extraWritableRoots: config.extraWritableRoots ?? [],
    streamIntervalMs: config.streamIntervalMs ?? 10_000,
    defaultProject,
    projects,
  };
}
```

- [ ] **Step 4: Create project registry**

Create `src/config/projects.ts`:

```ts
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
  const defaultProject = Object.entries(projects).find(([, project]) => project.cwd === defaultCwd)?.[0] ?? Object.keys(projects)[0];
  return { defaultProject, projects };
}

export async function resolveProjectRegistry(config: ProjectConfigShape): Promise<ProjectRegistry> {
  const entries = Object.entries(config.projects ?? {});
  if (entries.length === 0) throw new Error("No projects configured.");

  const projectsByAlias = new Map<string, ProjectDefinition>();
  const realpaths = new Map<string, string>();
  for (const [alias, project] of entries) {
    validateProjectAlias(alias);
    const cwd = await realpath(project.cwd);
    const gitRoot = await assertGitRepo(cwd);
    if (gitRoot !== cwd) {
      throw new Error(`Project ${alias} cwd must be a Git repo root: ${cwd}`);
    }
    const previousAlias = realpaths.get(cwd);
    if (previousAlias) {
      throw new Error(`Projects ${previousAlias} and ${alias} resolve to the same cwd: ${cwd}`);
    }
    realpaths.set(cwd, alias);
    projectsByAlias.set(alias, { alias, cwd });
  }

  const defaultAlias = config.defaultProject ?? entries[0][0];
  validateProjectAlias(defaultAlias);
  if (!projectsByAlias.has(defaultAlias)) {
    throw new Error(`Default project does not exist: ${defaultAlias}`);
  }

  return new ProjectRegistry(defaultAlias, projectsByAlias);
}
```

- [ ] **Step 5: Validate projects in preflight**

Edit `src/runtime/preflight.ts`:

```ts
import { resolveProjectRegistry } from "../config/projects.js";
```

Inside `runPreflightWithChecks`, replace the single cwd validation block with:

```ts
  const registry = await resolveProjectRegistry(config);
  const cwd = registry.defaultProject.cwd;
  await Promise.all((config.extraWritableRoots ?? []).map((root) => realpath(root)));

  return { codexVersion: codex.version, login, cwd };
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test
```

Expected: all tests pass. If old preflight tests fail because they construct configs without `projects`, update those test config objects to include `defaultProject` and `projects`, or make `runPreflightWithChecks` call `createLegacyProjects(config.defaultCwd, config.allowlistRoots)` when `config.projects` is empty.

Use this exact shape for legacy preflight test configs that still construct `BridgeConfig` inline:

```ts
{
  defaultCwd: repo,
  allowlistRoots: [repo],
  defaultProject: "repo",
  projects: {
    repo: { cwd: repo },
  },
  extraWritableRoots: [],
  streamIntervalMs: 1,
}
```

- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts src/config/projects.ts src/runtime/preflight.ts tests/projectConfig.test.ts tests/preflight.test.ts
git commit -m "feat: add explicit project registry"
```

---

### Task 3: Add Per-Project Session Storage

**Files:**
- Modify: `src/session/types.ts`
- Create: `src/session/projectSessionStore.ts`
- Test: `tests/projectSessionStore.test.ts`

- [ ] **Step 1: Write failing session store tests**

Create `tests/projectSessionStore.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { ProjectDefinition } from "../src/config/projects.js";

const bridge: ProjectDefinition = { alias: "bridge", cwd: "/tmp/bridge" };
const sage: ProjectDefinition = { alias: "SageTalk", cwd: "/tmp/SageTalk" };

test("ProjectSessionStore isolates sessions by bound user and project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  const store = new ProjectSessionStore(dir);

  const bridgeSession = await store.load("user-a", bridge, { resetStaleProcessing: false });
  bridgeSession.codexSessionId = "bridge-session";
  bridgeSession.history.push({ role: "user", content: "bridge prompt", timestamp: "2026-01-01T00:00:00.000Z" });
  await store.save(bridgeSession);

  const sageSession = await store.load("user-a", sage, { resetStaleProcessing: false });
  assert.equal(sageSession.codexSessionId, undefined);
  assert.equal(sageSession.history.length, 0);

  const loadedBridge = await store.load("user-a", bridge, { resetStaleProcessing: false });
  assert.equal(loadedBridge.codexSessionId, "bridge-session");
  assert.equal(loadedBridge.history.length, 1);

  await rm(dir, { recursive: true, force: true });
});

test("ProjectSessionStore resets stale processing state per project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  const store = new ProjectSessionStore(dir);
  const session = await store.load("user-a", sage, { resetStaleProcessing: false });
  session.state = "processing";
  session.activeTurnId = "turn-1";
  session.codexSessionId = "sage-session";
  await store.save(session);

  const loaded = await store.load("user-a", sage, { resetStaleProcessing: true });

  assert.equal(loaded.state, "idle");
  assert.equal(loaded.activeTurnId, undefined);
  assert.equal(loaded.codexSessionId, "sage-session");

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: fails because `ProjectSessionStore` does not exist.

- [ ] **Step 3: Add project session types**

Edit `src/session/types.ts`:

```ts
export interface ProjectSession extends BridgeSession {
  projectAlias: string;
}

export interface ProjectSessionDefaults {
  resetStaleProcessing?: boolean;
}
```

- [ ] **Step 4: Create ProjectSessionStore**

Create `src/session/projectSessionStore.ts`:

```ts
import { join } from "node:path";

import type { ProjectDefinition } from "../config/projects.js";
import { getSessionsDir } from "../config/paths.js";
import { loadSecureJson, saveSecureJson } from "../config/secureStore.js";
import { validateStorageId } from "../config/security.js";
import type { ChatHistoryEntry, ProjectSession, ProjectSessionDefaults } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 100;

export class ProjectSessionStore {
  constructor(private readonly sessionsDir = getSessionsDir()) {}

  async load(userId: string, project: ProjectDefinition, defaults: ProjectSessionDefaults = {}): Promise<ProjectSession> {
    validateStorageId(userId, "userId");
    validateStorageId(project.alias, "projectAlias");
    const session = loadSecureJson<ProjectSession | null>(this.pathFor(userId, project.alias), null) ?? {
      userId,
      projectAlias: project.alias,
      state: "idle",
      cwd: project.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: [project.cwd],
      updatedAt: new Date().toISOString(),
    };

    session.userId = userId;
    session.projectAlias = project.alias;
    session.cwd = project.cwd;
    session.mode ||= "readonly";
    session.history ||= [];
    session.allowlistRoots = [project.cwd];
    if (defaults.resetStaleProcessing && session.state !== "idle") {
      session.state = "idle";
      session.activeTurnId = undefined;
    }
    return session;
  }

  async save(session: ProjectSession): Promise<void> {
    validateStorageId(session.userId, "userId");
    validateStorageId(session.projectAlias, "projectAlias");
    session.updatedAt = new Date().toISOString();
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
    saveSecureJson(this.pathFor(session.userId, session.projectAlias), session);
  }

  async clear(userId: string, project: ProjectDefinition): Promise<ProjectSession> {
    const session: ProjectSession = {
      userId,
      projectAlias: project.alias,
      state: "idle",
      cwd: project.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: [project.cwd],
      updatedAt: new Date().toISOString(),
    };
    await this.save(session);
    return session;
  }

  addHistory(session: ProjectSession, role: ChatHistoryEntry["role"], content: string): void {
    session.history.push({ role, content, timestamp: new Date().toISOString() });
    if (session.history.length > DEFAULT_HISTORY_LIMIT) {
      session.history = session.history.slice(-DEFAULT_HISTORY_LIMIT);
    }
  }

  formatHistory(session: ProjectSession, limit = 20): string {
    const entries = session.history.slice(-Math.max(1, Math.min(limit, DEFAULT_HISTORY_LIMIT)));
    if (entries.length === 0) return "暂无对话记录";
    return entries
      .map((entry) => {
        const role = entry.role === "user" ? "用户" : "Codex";
        return `[${new Date(entry.timestamp).toLocaleString("zh-CN")}] ${role}:\n${entry.content}`;
      })
      .join("\n\n");
  }

  private pathFor(userId: string, projectAlias: string): string {
    validateStorageId(userId, "userId");
    validateStorageId(projectAlias, "projectAlias");
    return join(this.sessionsDir, userId, `${projectAlias}.json`);
  }
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/session/types.ts src/session/projectSessionStore.ts tests/projectSessionStore.test.ts
git commit -m "feat: store sessions per project"
```

---

### Task 4: Build Project Runtime And Manager

**Files:**
- Create: `src/core/ProjectRuntime.ts`
- Create: `src/core/ProjectRuntimeManager.ts`
- Create: `tests/projectRuntime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/projectRuntime.test.ts` with fake backend, fake sender, and two projects:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../src/backend/AgentBackend.js";
import { AgentService } from "../src/core/AgentService.js";
import { ProjectRuntimeManager } from "../src/core/ProjectRuntimeManager.js";
import { ProjectRegistry } from "../src/config/projects.js";
import { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { ProjectSession } from "../src/session/types.js";

class FakeBackend implements AgentBackend {
  interrupts: string[] = [];
  startRequests: AgentTurnRequest[] = [];
  resolvers: Array<(result: AgentTurnResult) => void> = [];

  startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.startRequests.push(request);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  resumeTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    return this.startTurn(request);
  }

  async interrupt(executionKey: string): Promise<void> {
    this.interrupts.push(executionKey);
    this.resolvers.shift()?.({ text: "", interrupted: true });
  }

  formatEventForWechat(): string | undefined {
    return undefined;
  }
}

class MemoryProjectSessionStore extends ProjectSessionStore {
  sessions = new Map<string, ProjectSession>();

  constructor() {
    super("/tmp/unused");
  }

  override async load(userId: string, project: { alias: string; cwd: string }): Promise<ProjectSession> {
    const key = `${userId}:${project.alias}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const session: ProjectSession = {
      userId,
      projectAlias: project.alias,
      state: "idle",
      cwd: project.cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: [project.cwd],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.sessions.set(key, session);
    return session;
  }

  override async save(session: ProjectSession): Promise<void> {
    this.sessions.set(`${session.userId}:${session.projectAlias}`, session);
  }
}

class MemorySender {
  messages: string[] = [];
  async sendText(_toUserId: string, _contextToken: string, text: string): Promise<void> {
    this.messages.push(text);
  }
}

function makeManager() {
  const registry = new ProjectRegistry("bridge", new Map([
    ["bridge", { alias: "bridge", cwd: "/tmp/bridge" }],
    ["SageTalk", { alias: "SageTalk", cwd: "/tmp/SageTalk" }],
  ]));
  const backend = new FakeBackend();
  const sender = new MemorySender();
  const manager = new ProjectRuntimeManager({
    account: { boundUserId: "user-1" },
    registry,
    sessionStore: new MemoryProjectSessionStore(),
    sender,
    agentService: new AgentService(backend),
    streamIntervalMs: 1,
    extraWritableRoots: [],
  });
  return { manager, backend, sender };
}

test("ProjectRuntimeManager runs different projects concurrently with separate execution keys", async () => {
  const { manager, backend } = makeManager();

  const bridgeRun = manager.runPrompt({ projectAlias: "bridge", prompt: "bridge task", toUserId: "user-1", contextToken: "ctx" });
  const sageRun = manager.runPrompt({ projectAlias: "SageTalk", prompt: "sage task", toUserId: "user-1", contextToken: "ctx" });
  await Promise.resolve();

  assert.equal(backend.startRequests.length, 2);
  assert.equal(backend.startRequests[0].executionKey, "user-1:bridge");
  assert.equal(backend.startRequests[1].executionKey, "user-1:SageTalk");

  backend.resolvers[0]({ text: "bridge done", interrupted: false, codexSessionId: "bridge-session" });
  backend.resolvers[1]({ text: "sage done", interrupted: false, codexSessionId: "sage-session" });
  await Promise.all([bridgeRun, sageRun]);
});

test("ProjectRuntimeManager rejects a second prompt for the same busy project", async () => {
  const { manager, sender } = makeManager();

  void manager.runPrompt({ projectAlias: "SageTalk", prompt: "long task", toUserId: "user-1", contextToken: "ctx" });
  await Promise.resolve();
  await manager.runPrompt({ projectAlias: "SageTalk", prompt: "new task", toUserId: "user-1", contextToken: "ctx" });

  assert.match(sender.messages.join("\n"), /SageTalk[\s\S]*正在处理|busy/i);
});

test("ProjectRuntimeManager replace interrupts then starts the replacement prompt", async () => {
  const { manager, backend } = makeManager();

  void manager.runPrompt({ projectAlias: "SageTalk", prompt: "old task", toUserId: "user-1", contextToken: "ctx" });
  await Promise.resolve();
  const replace = manager.replacePrompt({ projectAlias: "SageTalk", prompt: "new task", toUserId: "user-1", contextToken: "ctx" });
  await Promise.resolve();

  assert.deepEqual(backend.interrupts, ["user-1:SageTalk"]);
  backend.resolvers[0]?.({ text: "new done", interrupted: false, codexSessionId: "new-session" });
  await replace;
  assert.equal(backend.startRequests.at(-1)?.prompt, "new task");
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: fails because `ProjectRuntimeManager` does not exist.

- [ ] **Step 3: Create ProjectRuntime**

Create `src/core/ProjectRuntime.ts`:

```ts
import { randomUUID } from "node:crypto";

import { extractSessionId } from "../backend/codexEvents.js";
import type { ProjectDefinition } from "../config/projects.js";
import { logger } from "../logging/logger.js";
import { StreamBuffer } from "../runtime/streamBuffer.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentService } from "./AgentService.js";
import type { TextSender } from "./types.js";

export interface ProjectRuntimeOptions {
  userId: string;
  project: ProjectDefinition;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots: string[];
}

export interface RunProjectPromptInput {
  prompt: string;
  toUserId: string;
  contextToken: string;
  active: boolean;
}

export class BusyProjectError extends Error {
  constructor(readonly projectAlias: string) {
    super(`Project ${projectAlias} is busy`);
  }
}

export class ProjectRuntime {
  private sessionPromise?: Promise<ProjectSession>;

  constructor(private readonly options: ProjectRuntimeOptions) {}

  get executionKey(): string {
    return `${this.options.userId}:${this.options.project.alias}`;
  }

  async session(): Promise<ProjectSession> {
    this.sessionPromise ??= this.options.sessionStore.load(this.options.userId, this.options.project, { resetStaleProcessing: true });
    return this.sessionPromise;
  }

  async status(): Promise<ProjectSession> {
    return this.session();
  }

  async runPrompt(input: RunProjectPromptInput): Promise<void> {
    const session = await this.session();
    if (session.state === "processing") throw new BusyProjectError(this.options.project.alias);

    const turnId = randomUUID();
    session.state = "processing";
    session.activeTurnId = turnId;
    this.options.sessionStore.addHistory(session, "user", input.prompt);
    await this.options.sessionStore.save(session);

    const stream = new StreamBuffer({
      intervalMs: this.options.streamIntervalMs,
      send: (chunk) => this.options.sender.sendText(input.toUserId, input.contextToken, input.active ? chunk : `[${this.options.project.alias}] ${chunk}`),
    });

    try {
      const result = await this.options.agentService.runTurn({
        userId: this.options.userId,
        executionKey: this.executionKey,
        prompt: input.prompt,
        cwd: session.cwd,
        mode: session.mode,
        model: session.model,
        codexSessionId: session.codexSessionId,
        extraWritableRoots: this.options.extraWritableRoots,
      }, {
        onEvent: async (event: unknown, formatted?: string) => {
          if (session.activeTurnId !== turnId) return;
          const id = extractSessionId(event as never);
          if (id) {
            session.codexSessionId = id;
            session.codexThreadId = id;
          }
          if (!formatted) return;
          if (input.active || isBackgroundLifecycleEvent(event)) {
            await stream.append(formatted);
          }
        },
      });

      await stream.flush(true);
      if (session.activeTurnId !== turnId) return;
      if (result.clearedStaleSession) {
        session.codexSessionId = undefined;
        session.codexThreadId = undefined;
      }
      if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
      if (result.codexThreadId) session.codexThreadId = result.codexThreadId;
      if (!result.interrupted && result.text) {
        this.options.sessionStore.addHistory(session, "assistant", result.text);
        if (!input.active) {
          await this.options.sender.sendText(input.toUserId, input.contextToken, `[${this.options.project.alias}] 最终结果:\n${result.text}`);
        }
      }
      if (!result.interrupted && !result.text) {
        await this.options.sender.sendText(input.toUserId, input.contextToken, `${input.active ? "" : `[${this.options.project.alias}] `}Codex 本轮无文本返回。`);
      }
    } catch (error) {
      if (session.activeTurnId !== turnId) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Codex project turn failed", { project: this.options.project.alias, error: message });
      await this.options.sender.sendText(input.toUserId, input.contextToken, `${input.active ? "" : `[${this.options.project.alias}] `}Codex 处理失败: ${message}`);
    } finally {
      if (session.activeTurnId === turnId) {
        session.state = "idle";
        session.activeTurnId = undefined;
        await this.options.sessionStore.save(session);
      }
    }
  }

  async interrupt(): Promise<void> {
    await this.options.agentService.interrupt(this.executionKey);
    const session = await this.session();
    session.state = "idle";
    session.activeTurnId = undefined;
    await this.options.sessionStore.save(session);
  }

  async clear(): Promise<ProjectSession> {
    await this.interrupt();
    const session = await this.options.sessionStore.clear(this.options.userId, this.options.project);
    this.sessionPromise = Promise.resolve(session);
    return session;
  }
}

function isBackgroundLifecycleEvent(event: unknown): boolean {
  const type = typeof event === "object" && event && "type" in event ? String((event as { type?: unknown }).type) : "";
  return type === "turn.started" || type === "turn.completed" || type === "turn.failed";
}
```

- [ ] **Step 4: Create ProjectRuntimeManager**

Create `src/core/ProjectRuntimeManager.ts`:

```ts
import type { AccountData } from "../config/accounts.js";
import type { ProjectRegistry } from "../config/projects.js";
import type { ProjectSessionStore } from "../session/projectSessionStore.js";
import type { ProjectSession } from "../session/types.js";
import type { AgentMode } from "../backend/AgentBackend.js";
import type { AgentService } from "./AgentService.js";
import { BusyProjectError, ProjectRuntime } from "./ProjectRuntime.js";
import type { TextSender } from "./types.js";

export interface ProjectRuntimeManagerOptions {
  account: Pick<AccountData, "boundUserId">;
  registry: ProjectRegistry;
  sessionStore: ProjectSessionStore;
  sender: TextSender;
  agentService: AgentService;
  streamIntervalMs: number;
  extraWritableRoots: string[];
}

export interface ProjectPromptInput {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
}

export class ProjectRuntimeManager {
  private activeAlias: string;
  private readonly runtimes = new Map<string, ProjectRuntime>();

  constructor(private readonly options: ProjectRuntimeManagerOptions) {
    this.activeAlias = options.registry.defaultAlias;
  }

  get activeProjectAlias(): string {
    return this.activeAlias;
  }

  setActiveProject(alias: string): void {
    this.options.registry.get(alias);
    this.activeAlias = alias;
  }

  runtime(alias = this.activeAlias): ProjectRuntime {
    const project = this.options.registry.get(alias);
    let runtime = this.runtimes.get(project.alias);
    if (!runtime) {
      runtime = new ProjectRuntime({
        userId: this.options.account.boundUserId,
        project,
        sessionStore: this.options.sessionStore,
        sender: this.options.sender,
        agentService: this.options.agentService,
        streamIntervalMs: this.options.streamIntervalMs,
        extraWritableRoots: this.options.extraWritableRoots,
      });
      this.runtimes.set(project.alias, runtime);
    }
    return runtime;
  }

  async runPrompt(input: ProjectPromptInput): Promise<void> {
    const alias = input.projectAlias ?? this.activeAlias;
    const runtime = this.runtime(alias);
    try {
      await runtime.runPrompt({ ...input, active: alias === this.activeAlias });
    } catch (error) {
      if (error instanceof BusyProjectError) {
        await this.options.sender.sendText(input.toUserId, input.contextToken, `[${alias}] 正在处理上一轮任务。请使用 /interrupt ${alias} 或 /replace ${alias} <prompt>。`);
        return;
      }
      throw error;
    }
  }

  async replacePrompt(input: ProjectPromptInput): Promise<void> {
    const alias = input.projectAlias ?? this.activeAlias;
    await this.runtime(alias).interrupt();
    await this.runtime(alias).runPrompt({ ...input, active: alias === this.activeAlias });
  }

  async interrupt(alias = this.activeAlias): Promise<void> {
    await this.runtime(alias).interrupt();
  }

  async clear(alias = this.activeAlias): Promise<ProjectSession> {
    return this.runtime(alias).clear();
  }

  async setMode(alias: string | undefined, mode: AgentMode): Promise<ProjectSession> {
    const session = await this.runtime(alias).session();
    session.mode = mode;
    await this.options.sessionStore.save(session);
    return session;
  }

  async setModel(alias: string | undefined, model: string | undefined): Promise<ProjectSession> {
    const session = await this.runtime(alias).session();
    session.model = model;
    await this.options.sessionStore.save(session);
    return session;
  }

  async session(alias = this.activeAlias): Promise<ProjectSession> {
    return this.runtime(alias).session();
  }

  listProjects(): { alias: string; cwd: string; active: boolean }[] {
    return this.options.registry.list().map((project) => ({
      alias: project.alias,
      cwd: project.cwd,
      active: project.alias === this.activeAlias,
    }));
  }
}
```

- [ ] **Step 5: Run tests and fix type errors**

Run:

```bash
npm test
```

Expected: new project runtime tests pass after TypeScript imports and fake overrides are adjusted. Existing tests may still pass because no production caller uses the new manager yet.

- [ ] **Step 6: Commit**

```bash
git add src/core/ProjectRuntime.ts src/core/ProjectRuntimeManager.ts tests/projectRuntime.test.ts
git commit -m "feat: add project runtime manager"
```

---

### Task 5: Add Project-Aware WeChat Commands And Prompt Parsing

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing command tests**

Add tests to `tests/commands.test.ts` for parsing and command behavior. Use a fake manager object that exposes `setActiveProject`, `listProjects`, `interrupt`, `replacePrompt`, `clear`, `setMode`, `setModel`, `session`, and `runPrompt`.

```ts
test("/project lists and switches active project", async () => {
  const manager = makeFakeProjectManager();

  const list = await routeCommand({ text: "/project", projectManager: manager, boundUserId: "user-1" });
  assert.match(list.reply ?? "", /bridge/);
  assert.match(list.reply ?? "", /SageTalk/);

  const switched = await routeCommand({ text: "/project SageTalk", projectManager: manager, boundUserId: "user-1" });
  assert.equal(manager.activeProjectAlias, "SageTalk");
  assert.match(switched.reply ?? "", /SageTalk/);
});

test("/interrupt and /replace target explicit projects", async () => {
  const manager = makeFakeProjectManager();

  await routeCommand({ text: "/interrupt SageTalk", projectManager: manager, boundUserId: "user-1" });
  await routeCommand({ text: "/replace SageTalk run tests", projectManager: manager, boundUserId: "user-1" });

  assert.deepEqual(manager.interrupted, ["SageTalk"]);
  assert.deepEqual(manager.replacements, [{ projectAlias: "SageTalk", prompt: "run tests" }]);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: tests fail because `routeCommand` does not accept `projectManager`.

- [ ] **Step 3: Extend command context**

Edit `src/commands/handlers.ts`:

```ts
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";

export interface CommandContext {
  text: string;
  session?: BridgeSession;
  projectManager?: ProjectRuntimeManager;
  boundUserId: string;
  clearSession?: () => Promise<BridgeSession>;
  formatHistory?: (limit?: number) => string;
}
```

Keep existing single-session handlers working when `projectManager` is absent.

- [ ] **Step 4: Add project handlers**

Add handlers in `src/commands/handlers.ts`:

```ts
export async function handleProject(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!ctx.projectManager) return { handled: true, reply: "当前运行时不支持 project 命令。" };
  if (!args) {
    const lines = ctx.projectManager.listProjects().map((project) => `${project.active ? "* " : "- "}${project.alias} ${project.cwd}`);
    return { handled: true, reply: [`当前项目: ${ctx.projectManager.activeProjectAlias}`, "", "项目:", ...lines].join("\n") };
  }
  ctx.projectManager.setActiveProject(args);
  return { handled: true, reply: `当前项目已切换为: ${args}` };
}

export async function handleInterrupt(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!ctx.projectManager) return { handled: true, reply: "当前运行时不支持 interrupt 命令。" };
  const alias = args || undefined;
  await ctx.projectManager.interrupt(alias);
  return { handled: true, reply: `已中断项目: ${alias ?? ctx.projectManager.activeProjectAlias}` };
}

export async function handleReplace(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!ctx.projectManager) return { handled: true, reply: "当前运行时不支持 replace 命令。" };
  const parts = args.split(/\s+/);
  const first = parts[0];
  const projectAlias = first && ctx.projectManager.listProjects().some((project) => project.alias === first) ? first : undefined;
  const prompt = projectAlias ? args.slice(projectAlias.length).trim() : args.trim();
  if (!prompt) return { handled: true, reply: "用法: /replace [project] <prompt>" };
  await ctx.projectManager.replacePrompt({ projectAlias, prompt, toUserId: ctx.boundUserId, contextToken: "" });
  return { handled: true };
}
```

- [ ] **Step 5: Route new commands**

Edit `src/commands/router.ts` imports and switch:

```ts
  handleInterrupt,
  handleProject,
  handleReplace,
```

Add cases:

```ts
    case "project":
      return handleProject(ctx, args);
    case "interrupt":
      return handleInterrupt(ctx, args);
    case "replace":
      return handleReplace(ctx, args);
```

- [ ] **Step 6: Update existing handlers for project manager**

Update `/status`, `/history`, `/mode`, `/model`, and `/clear` handlers so they use `ctx.projectManager` when present and fall back to old `ctx.session` behavior when absent. For example:

```ts
export async function handleStatus(ctx: CommandContext, args = ""): Promise<CommandResult> {
  if (ctx.projectManager) {
    if (!args) {
      const lines = ctx.projectManager.listProjects().map((project) => `${project.active ? "* " : "- "}${project.alias} ${project.cwd}`);
      return { handled: true, reply: [`当前项目: ${ctx.projectManager.activeProjectAlias}`, ...lines].join("\n") };
    }
    const session = await ctx.projectManager.session(args);
    return { handled: true, reply: formatSessionStatus(args, session) };
  }
  if (!ctx.session) return { handled: true, reply: "会话不可用。" };
  return { handled: true, reply: formatSessionStatus("当前", ctx.session) };
}
```

Add helper:

```ts
function formatSessionStatus(label: string, session: BridgeSession): string {
  return [
    `项目: ${label}`,
    `状态: ${session.state}`,
    `工作目录: ${session.cwd}`,
    `模式: ${session.mode}`,
    `模型: ${session.model ?? "Codex 默认"}`,
    `Codex session: ${session.codexSessionId ?? "无"}`,
    `历史条数: ${session.history.length}`,
  ].join("\n");
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test
```

Expected: command tests pass after fake manager signatures match production methods.

- [ ] **Step 8: Commit**

```bash
git add src/commands/handlers.ts src/commands/router.ts tests/commands.test.ts
git commit -m "feat: add project chat commands"
```

---

### Task 6: Integrate Project Runtime Into BridgeService

**Files:**
- Modify: `src/core/BridgeService.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/bridge.test.ts`
- Test: `tests/coreServices.test.ts`

- [ ] **Step 1: Write failing bridge routing tests**

Add tests to `tests/coreServices.test.ts`:

```ts
test("BridgeService routes @Project prompts without changing active project", async () => {
  const { bridge, backend } = makeProjectBridge();

  await bridge.handleMessage(textMessage("user-1", "@SageTalk run tests"));

  assert.equal(backend.startRequests[0].cwd, "/tmp/SageTalk");
  assert.equal(backend.startRequests[0].prompt, "run tests");
});

test("BridgeService rejects same-project prompt while busy", async () => {
  const { bridge, sender } = makeBusyProjectBridge("SageTalk");

  await bridge.handleMessage(textMessage("user-1", "@SageTalk second task"));

  assert.match(sender.messages.join("\n"), /SageTalk[\s\S]*正在处理|busy/i);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: fails because `BridgeService` still uses a single `session`.

- [ ] **Step 3: Update BridgeService options**

Edit `src/core/BridgeService.ts`:

```ts
import type { ProjectRuntimeManager } from "./ProjectRuntimeManager.js";

export interface BridgeServiceOptions {
  account: AccountData;
  projectManager: ProjectRuntimeManager;
  sender: TextSender;
}
```

Keep a compatibility constructor path only if existing tests need it during migration. The final production service should require `projectManager`.

- [ ] **Step 4: Add targeted prompt parser**

In `src/core/BridgeService.ts`, add:

```ts
function parseTargetedPrompt(text: string): { projectAlias: string; prompt: string } | undefined {
  const match = text.trim().match(/^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
  if (!match) return undefined;
  return { projectAlias: match[1], prompt: match[2].trim() };
}
```

- [ ] **Step 5: Rewrite message handling around project manager**

Replace command and ordinary prompt routing in `handleMessage`:

```ts
    if (text.trim().startsWith("/")) {
      const result = await routeCommand({
        text,
        projectManager: this.projectManager,
        boundUserId: this.account.boundUserId,
        toUserId: fromUserId,
        contextToken,
      });
      if (result.handled && result.reply) {
        await this.sender.sendText(fromUserId, contextToken, result.reply);
      }
      return;
    }

    const targeted = parseTargetedPrompt(text);
    await this.projectManager.runPrompt({
      projectAlias: targeted?.projectAlias,
      prompt: targeted?.prompt ?? text,
      toUserId: fromUserId,
      contextToken,
    });
```

Add `toUserId` and `contextToken` to `CommandContext` so `/replace` can send replacement output to the actual WeChat context.

- [ ] **Step 6: Update runtime assembly**

Edit `src/runtime/bridge.ts`:

```ts
import { resolveProjectRegistry } from "../config/projects.js";
import { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import { ProjectSessionStore } from "../session/projectSessionStore.js";
```

Inside `runBridge`, replace single-session load with:

```ts
  const registry = await resolveProjectRegistry(config);
  const extraWritableRoots = await Promise.all(config.extraWritableRoots.map((root) => realpath(root)));
  const projectSessionStore = new ProjectSessionStore();
  const agentService = new AgentService(backend);
```

Create manager:

```ts
  const projectManager = new ProjectRuntimeManager({
    account,
    registry,
    sessionStore: projectSessionStore,
    sender,
    agentService,
    streamIntervalMs: config.streamIntervalMs,
    extraWritableRoots,
  });
```

Create bridge:

```ts
  const bridgeService = new BridgeService({
    account,
    projectManager,
    sender,
  });
```

Shutdown must interrupt every known runtime. Add manager method `interruptAll()` and call:

```ts
    await projectManager.interruptAll();
```

- [ ] **Step 7: Update test helper**

Update `handleMessageForTest` in `src/runtime/bridge.ts` to create a `ProjectRegistry` with one default project from the old `session.cwd`, plus a `ProjectRuntimeManager`. This preserves old tests while new project tests use a direct manager:

```ts
  const registry = new ProjectRegistry("default", new Map([["default", { alias: "default", cwd: session.cwd }]]));
```

- [ ] **Step 8: Run tests**

Run:

```bash
npm test
```

Expected: old tests that asserted automatic interrupt-on-new-message should now be updated to assert busy rejection for same project. Different-project prompt tests should pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/BridgeService.ts src/runtime/bridge.ts tests/bridge.test.ts tests/coreServices.test.ts
git commit -m "feat: route wechat messages by project"
```

---

### Task 7: Extend MCP Tools With Project Arguments

**Files:**
- Modify: `src/mcp/context.ts`
- Modify: `src/mcp/tools/types.ts`
- Modify: `src/mcp/tools/agentResume.ts`
- Modify: `src/mcp/tools/agentInterrupt.ts`
- Modify: `src/mcp/tools/agentSetMode.ts`
- Modify: `src/mcp/tools/agentSetCwd.ts`
- Modify: `src/mcp/tools/sessionClear.ts`
- Modify: `src/mcp/tools/wechatHistory.ts`
- Modify: `src/mcp/tools/wechatStatus.ts`
- Test: `tests/mcpTools.test.ts`

- [ ] **Step 1: Write failing MCP project tests**

Add to `tests/mcpTools.test.ts`:

```ts
test("agent_resume accepts a project argument", async () => {
  const context = makeProjectContext();

  const result = await callBridgeTool(context, "agent_resume", { project: "SageTalk", prompt: "continue" });

  assert.equal(result.ok, true);
  assert.equal(context.backend.startRequests[0].cwd, "/tmp/SageTalk");
  assert.equal(context.backend.startRequests[0].executionKey, "user-1:SageTalk");
});

test("agent_set_mode and wechat_history target project sessions", async () => {
  const context = makeProjectContext();

  const mode = await callBridgeTool(context, "agent_set_mode", { project: "SageTalk", mode: "workspace" });
  assert.equal(mode.ok, true);

  const history = await callBridgeTool(context, "wechat_history", { project: "SageTalk", limit: 5 });
  assert.equal(history.ok, true);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test
```

Expected: fails because MCP context lacks `projectManager`.

- [ ] **Step 3: Add project manager to MCP context**

Edit `src/mcp/tools/types.ts`:

```ts
import type { ProjectRuntimeManager } from "../../core/ProjectRuntimeManager.js";

export interface BridgeMcpContext {
  account: AccountData | null;
  projectManager: ProjectRuntimeManager | null;
  agentService: AgentService;
  extraWritableRoots?: string[];
  session?: BridgeSession | null;
  sessionStore?: SessionStorePort | null;
}

export function requireProjectManager(context: BridgeMcpContext): {
  account: AccountData;
  projectManager: ProjectRuntimeManager;
} {
  if (!context.account) throw new Error("WeChat account is not bound. Run npm run setup first.");
  if (!context.projectManager) throw new Error("Project runtime is not available.");
  return { account: context.account, projectManager: context.projectManager };
}
```

- [ ] **Step 4: Build project manager in MCP context loader**

Edit `src/mcp/context.ts`:

```ts
  const registry = await resolveProjectRegistry(config);
  const projectSessionStore = new ProjectSessionStore();
  const noopSender = { async sendText(): Promise<void> {} };
  const projectManager = new ProjectRuntimeManager({
    account,
    registry,
    sessionStore: projectSessionStore,
    sender: noopSender,
    agentService: new AgentService(backend),
    streamIntervalMs: config.streamIntervalMs,
    extraWritableRoots,
  });
```

Return:

```ts
  return {
    account,
    projectManager,
    agentService: new AgentService(backend),
    extraWritableRoots,
  };
```

- [ ] **Step 5: Update MCP tools to use project manager**

Example for `src/mcp/tools/agentResume.ts`:

```ts
import { requireProjectManager, stringInput } from "./types.js";

async handler(context, input) {
  const { account, projectManager } = requireProjectManager(context);
  const prompt = stringInput(input, "prompt");
  const project = stringInput(input, "project");
  if (!prompt) throw new BridgeError("INVALID_ARGUMENT", "prompt is required");
  await projectManager.runPrompt({ projectAlias: project, prompt, toUserId: account.boundUserId, contextToken: "" });
  const session = await projectManager.session(project);
  return ok({ text: session.history.at(-1)?.role === "assistant" ? session.history.at(-1)?.content : "", codexSessionId: session.codexSessionId, codexThreadId: session.codexThreadId });
}
```

Example for `src/mcp/tools/agentInterrupt.ts`:

```ts
const project = stringInput(input, "project");
await projectManager.interrupt(project);
return ok({ interrupted: true, project: project ?? projectManager.activeProjectAlias, userId: account.boundUserId });
```

Use the same `project` optional input in mode, clear, status, and history tools.

- [ ] **Step 6: Keep listBridgeTools stable**

Do not remove existing tool names. Optionally add `agent_set_project` in a later task, but this task keeps the current MCP tool list stable.

- [ ] **Step 7: Run tests**

Run:

```bash
npm test
```

Expected: MCP tests pass and old callers without `project` target the active project.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/context.ts src/mcp/tools tests/mcpTools.test.ts
git commit -m "feat: add project-aware mcp tools"
```

---

### Task 8: Update Setup And Documentation

**Files:**
- Modify: `src/setup/setup.ts`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `README_ES.md`
- Modify: `README_JA.md`
- Modify: `README_KO.md`
- Modify: `docs/mcp.md`
- Test: `tests/projectName.test.ts`

- [ ] **Step 1: Add README command coverage test**

Add this metadata-style test to `tests/projectName.test.ts` so docs coverage fails until the user-facing project commands are documented:

```ts
test("readme documents multi-project commands", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /\/project/);
  assert.match(readme, /\/interrupt/);
  assert.match(readme, /\/replace/);
  assert.match(readme, /SageTalk/);
});
```

- [ ] **Step 2: Update setup config save**

Edit `src/setup/setup.ts` so `saveConfig` includes explicit project fields:

```ts
const defaultAlias = defaultCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "default";
const projects = Object.fromEntries(
  allowlistRoots.map((root) => {
    const alias = root.split(/[\\/]/).filter(Boolean).at(-1) ?? "default";
    return [alias, { cwd: root }];
  }),
);
saveConfig({
  defaultCwd,
  allowlistRoots,
  defaultProject: projects[defaultAlias] ? defaultAlias : Object.keys(projects)[0],
  projects,
  extraWritableRoots: current.extraWritableRoots,
  streamIntervalMs: current.streamIntervalMs,
});
```

- [ ] **Step 3: Update README commands**

In `README.md`, add this multi-project section:

````md
## 多项目会话

`config.json` 可以显式配置项目别名：

```json
{
  "defaultProject": "bridge",
  "projects": {
    "bridge": { "cwd": "/Users/lixinyao/.codex/projects/wechat-agent-bridge" },
    "SageTalk": { "cwd": "/Users/lixinyao/.codex/projects/SageTalk" }
  },
  "extraWritableRoots": [],
  "streamIntervalMs": 10000
}
```

微信里使用：

- `/project` 查看项目列表。
- `/project SageTalk` 切换当前项目。
- `@SageTalk 帮我看测试失败` 只把这一条发给 SageTalk。
- `/interrupt SageTalk` 中断 SageTalk 当前任务。
- `/replace SageTalk 重新按这个方案实现` 中断并替换 SageTalk 当前任务。

每个项目独立保存 Codex session、history、mode 和 model。不同项目可以同时运行；同一项目正在处理时，新消息会被拒绝，除非使用 `/replace`。
````

Mirror the same section in the translated README files.

- [ ] **Step 4: Update MCP docs**

In `docs/mcp.md`, add optional project examples:

````md
Project-aware calls:

```json
{ "project": "SageTalk", "prompt": "run tests and summarize failures" }
```

If `project` is omitted, tools target the active project.
````

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: docs metadata test passes.

- [ ] **Step 6: Commit**

```bash
git add src/setup/setup.ts README.md README_EN.md README_ES.md README_JA.md README_KO.md docs/mcp.md tests/projectName.test.ts
git commit -m "docs: document multi-project sessions"
```

---

### Task 9: Full Verification And Push

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 2: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass with 0 failures.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: `tsc -p tsconfig.json` exits 0.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: clean working tree on `main`, ahead of `origin/main` by the new commits.

- [ ] **Step 5: Push**

Run:

```bash
git push
```

Expected: `main -> main` push succeeds.

---

## Spec Coverage Checklist

- Explicit project aliases: Task 2.
- Per-project session/history/mode/model: Tasks 3 and 4.
- Concurrent projects with one task per project: Task 4.
- Same-project busy rejection unless interrupt/replace: Task 4 and Task 5.
- `/project`, `@Project`, `/interrupt`, `/replace`: Task 5 and Task 6.
- Active/background output policy: Task 4.
- Codex execution by project cwd: Task 4 and Task 6.
- Per-project execution key: Task 1.
- MCP optional project arguments: Task 7.
- Setup and docs: Task 8.
- Verification: Task 9.
