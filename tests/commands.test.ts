import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { routeCommand } from "../src/commands/router.js";
import type { AgentMode } from "../src/backend/AgentBackend.js";
import type { ModelCatalog, ModelState } from "../src/core/ModelService.js";
import type { BridgeSession, ProjectSession } from "../src/session/types.js";

function createSession(root: string): BridgeSession {
  return {
    userId: "user-1",
    state: "idle",
    cwd: root,
    mode: "readonly",
    history: [],
    allowlistRoots: [root],
    updatedAt: new Date().toISOString(),
  };
}

const bridgeProject = { alias: "bridge", cwd: "/tmp/bridge", active: true };
const sageProject = { alias: "SageTalk", cwd: "/tmp/sage", active: false };

class FakeProjectManager {
  activeProjectAlias = "bridge";
  interrupts: Array<string | undefined> = [];
  replacements: Array<{ projectAlias?: string; prompt: string; toUserId: string; contextToken: string }> = [];
  clears: Array<string | undefined> = [];
  initialized: string[] = [];
  readonly sessions = new Map<string, ProjectSession>();
  readonly ready = new Map<string, boolean>([
    ["bridge", true],
    ["SageTalk", true],
  ]);

  constructor() {
    this.sessions.set("bridge", this.createProjectSession("bridge", "/tmp/bridge"));
    this.sessions.set("SageTalk", this.createProjectSession("SageTalk", "/tmp/sage"));
  }

  addProject(alias: string, cwd: string, ready = true): void {
    this.sessions.set(alias, this.createProjectSession(alias, cwd));
    this.ready.set(alias, ready);
  }

  async listProjects(): Promise<Array<{ alias: string; cwd: string; ready: boolean; active: boolean }>> {
    return Array.from(this.sessions.keys()).map((alias) => ({
      alias,
      cwd: this.sessions.get(alias)!.cwd,
      ready: this.ready.get(alias) ?? true,
      active: alias === this.activeProjectAlias,
    }));
  }

  async setActiveProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    const project = (await this.listProjects()).find((item) => item.alias === alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    this.activeProjectAlias = alias;
    return { alias: project.alias, cwd: project.cwd, ready: project.ready };
  }

  async initializeProject(alias: string): Promise<{ alias: string; cwd: string; ready: boolean }> {
    this.assertProject(alias);
    this.ready.set(alias, true);
    this.initialized.push(alias);
    const session = this.sessions.get(alias)!;
    this.activeProjectAlias = alias;
    return { alias, cwd: session.cwd, ready: true };
  }

  async interrupt(alias?: string): Promise<void> {
    this.assertProject(alias ?? this.activeProjectAlias);
    this.interrupts.push(alias);
  }

  async replacePrompt(options: { projectAlias?: string; prompt: string; toUserId: string; contextToken: string }): Promise<void> {
    this.assertProject(options.projectAlias ?? this.activeProjectAlias);
    this.replacements.push(options);
  }

  async clear(alias?: string): Promise<ProjectSession> {
    this.assertProject(alias ?? this.activeProjectAlias);
    this.clears.push(alias);
    const current = await this.session(alias);
    current.codexSessionId = undefined;
    current.codexThreadId = undefined;
    current.history = [];
    current.state = "idle";
    return current;
  }

  async setMode(alias: string | undefined, mode: AgentMode | string): Promise<ProjectSession> {
    const session = await this.session(alias);
    session.mode = mode as AgentMode;
    return session;
  }

  async setModel(alias: string | undefined, model: string | undefined): Promise<ProjectSession> {
    const session = await this.session(alias);
    session.model = model?.trim() || undefined;
    return session;
  }

  async session(alias = this.activeProjectAlias): Promise<ProjectSession> {
    const session = this.sessions.get(alias);
    if (!session) throw new Error(`Unknown project: ${alias}`);
    return session;
  }

  private createProjectSession(alias: string, cwd: string): ProjectSession {
    return {
      userId: "user-1",
      projectAlias: alias,
      state: "idle",
      cwd,
      mode: "readonly",
      history: [],
      allowlistRoots: [cwd],
      updatedAt: new Date().toISOString(),
    };
  }

  private assertProject(alias: string): void {
    if (!this.sessions.has(alias)) throw new Error(`Unknown project: ${alias}`);
  }
}

class FakeModelService {
  catalog: ModelCatalog = {
    models: [
      {
        slug: "gpt-5.5",
        displayName: "GPT-5.5",
        defaultReasoningLevel: "medium",
        description: "Frontier coding model",
      },
    ],
  };
  failure?: Error;

  async describeSession(session: Pick<ProjectSession, "model">): Promise<ModelState> {
    const configuredModel = session.model?.trim() || undefined;
    if (configuredModel) {
      return {
        configuredModel,
        codexDefaultModel: "gpt-default",
        effectiveModel: configuredModel,
        source: "project override",
      };
    }
    return {
      codexDefaultModel: "gpt-default",
      effectiveModel: "gpt-default",
      source: "codex config",
    };
  }

  async listModels(): Promise<ModelCatalog> {
    if (this.failure) throw this.failure;
    return this.catalog;
  }
}

test("/mode switches among safe modes and requires explicit yolo", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-")));
  const session = createSession(root);

  const workspace = await routeCommand({ text: "/mode workspace", session, boundUserId: "user-1" });
  assert.equal(workspace.handled, true);
  assert.equal(session.mode, "workspace");

  const yolo = await routeCommand({ text: "/mode yolo", session, boundUserId: "user-1" });
  assert.equal(yolo.handled, true);
  assert.equal(session.mode, "yolo");
  assert.match(yolo.reply ?? "", /危险|danger/i);

  const invalid = await routeCommand({ text: "/mode auto", session, boundUserId: "user-1" });
  assert.equal(session.mode, "yolo");
  assert.match(invalid.reply ?? "", /未知模式/);

  await rm(root, { recursive: true, force: true });
});

test("legacy /model only changes on a non-empty model name", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-")));
  const session = createSession(root);
  session.model = "existing-model";

  const noArg = await routeCommand({ text: "/model", session, boundUserId: "user-1" });
  const whitespace = await routeCommand({ text: "/model     ", session, boundUserId: "user-1" });

  assert.equal(noArg.handled, true);
  assert.match(noArg.reply ?? "", /existing-model/);
  assert.equal(whitespace.handled, true);
  assert.match(whitespace.reply ?? "", /existing-model/);
  assert.equal(session.model, "existing-model");

  const set = await routeCommand({ text: "/model gpt-5", session, boundUserId: "user-1" });
  assert.equal(set.handled, true);
  assert.equal(session.model, "gpt-5");

  await rm(root, { recursive: true, force: true });
});

test("/cwd only switches into allowlist roots", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-")));
  mkdirSync(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const child = join(root, "child");
  mkdirSync(child);
  const outside = await realpath(mkdtempSync(join(tmpdir(), "wcb-outside-")));
  const session = createSession(root);

  const accepted = await routeCommand({ text: `/cwd ${root}`, session, boundUserId: "user-1" });
  assert.equal(accepted.handled, true);
  assert.equal(session.cwd, root);

  const rejected = await routeCommand({ text: `/cwd ${child}`, session, boundUserId: "user-1" });
  assert.equal(rejected.handled, true);
  assert.match(rejected.reply ?? "", /repo root|允许/);
  assert.equal(session.cwd, root);

  const outsideRejected = await routeCommand({ text: `/cwd ${outside}`, session, boundUserId: "user-1" });
  assert.equal(outsideRejected.handled, true);
  assert.match(outsideRejected.reply ?? "", /repo root|允许/);
  assert.equal(session.cwd, root);

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

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

test("/help help shows detailed syntax for command help", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({ text: "/help help", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /\/help/);
  assert.match(result.reply ?? "", /\/help <command>/);
});

test("/help models shows model catalog command details", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({ text: "/help models", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /命令: \/models/);
  assert.match(result.reply ?? "", /codex debug models/i);
});

test("/project lists projects and switches the active project", async () => {
  const projectManager = new FakeProjectManager();

  const list = await routeCommand({ text: "/project", projectManager, boundUserId: "user-1" });
  assert.equal(list.handled, true);
  assert.match(list.reply ?? "", /\* bridge/);
  assert.match(list.reply ?? "", /SageTalk/);
  assert.match(list.reply ?? "", /当前项目: bridge/);

  const switched = await routeCommand({ text: "/project SageTalk", projectManager, boundUserId: "user-1" });
  assert.equal(switched.handled, true);
  assert.equal(projectManager.activeProjectAlias, "SageTalk");
  assert.match(switched.reply ?? "", /SageTalk/);
});

test("/project requires explicit --init before switching to a non-git child", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.addProject("scratch", "/tmp/scratch", false);

  const blocked = await routeCommand({ text: "/project scratch", projectManager, boundUserId: "user-1" });
  const confirmed = await routeCommand({ text: "/project scratch --init", projectManager, boundUserId: "user-1" });

  assert.equal(blocked.handled, true);
  assert.match(blocked.reply ?? "", /\/project scratch --init/);
  assert.deepEqual(projectManager.initialized, ["scratch"]);
  assert.equal(projectManager.activeProjectAlias, "scratch");
  assert.match(confirmed.reply ?? "", /当前项目已切换为: scratch/);
});

test("project commands without a project manager return intentional user-facing errors", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-")));
  const session = createSession(root);

  const result = await routeCommand({ text: "/project", session, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.equal(result.reply, "当前会话不支持项目命令。");

  await rm(root, { recursive: true, force: true });
});

test("/interrupt targets active and explicit projects", async () => {
  const projectManager = new FakeProjectManager();
  await projectManager.setActiveProject("SageTalk");

  const active = await routeCommand({ text: "/interrupt", projectManager, boundUserId: "user-1" });
  const explicit = await routeCommand({ text: "/interrupt bridge", projectManager, boundUserId: "user-1" });

  assert.equal(active.handled, true);
  assert.equal(explicit.handled, true);
  assert.deepEqual(projectManager.interrupts, [undefined, "bridge"]);
});

test("/replace targets explicit and active projects with WeChat context", async () => {
  const projectManager = new FakeProjectManager();
  await projectManager.setActiveProject("SageTalk");

  const explicit = await routeCommand({
    text: "/replace bridge fix tests",
    projectManager,
    boundUserId: "bound-user",
    toUserId: "wechat-user",
    contextToken: "ctx-123",
  });
  const active = await routeCommand({ text: "/replace continue work", projectManager, boundUserId: "bound-user" });

  assert.equal(explicit.handled, true);
  assert.equal(active.handled, true);
  assert.deepEqual(projectManager.replacements, [
    { projectAlias: "bridge", prompt: "fix tests", toUserId: "wechat-user", contextToken: "ctx-123" },
    { prompt: "continue work", toUserId: "bound-user", contextToken: "" },
  ]);

  const missing = await routeCommand({ text: "/replace bridge", projectManager, boundUserId: "bound-user" });
  assert.match(missing.reply ?? "", /用法: \/replace/);
});

test("/replace treats a non-alias first token as part of the active prompt", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({ text: "/replace UnknownAlias keep this token", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.deepEqual(projectManager.replacements, [
    { prompt: "UnknownAlias keep this token", toUserId: "user-1", contextToken: "" },
  ]);
});

test("project-aware /status shows overview and targeted session details", async () => {
  const projectManager = new FakeProjectManager();
  const modelService = new FakeModelService();
  const sage = await projectManager.session("SageTalk");
  sage.state = "processing";
  sage.model = "gpt-sage";
  sage.history.push({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" });

  const overview = await routeCommand({ text: "/status", projectManager, modelService, boundUserId: "user-1" });
  const targeted = await routeCommand({ text: "/status SageTalk", projectManager, modelService, boundUserId: "user-1" });

  assert.equal(overview.handled, true);
  assert.match(overview.reply ?? "", /项目状态/);
  assert.match(overview.reply ?? "", /\* bridge/);
  assert.match(overview.reply ?? "", /SageTalk.*processing.*gpt-sage/);
  assert.equal(targeted.handled, true);
  assert.match(targeted.reply ?? "", /项目: SageTalk/);
  assert.match(targeted.reply ?? "", /状态: processing/);
  assert.match(targeted.reply ?? "", /历史条数: 1/);
});

test("project-aware /status targeted details show effective model source", async () => {
  const projectManager = new FakeProjectManager();
  const modelService = new FakeModelService();
  await projectManager.setModel("bridge", "gpt-5.5");

  const result = await routeCommand({ text: "/status bridge", projectManager, modelService, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /模型: gpt-5\.5/);
  assert.match(result.reply ?? "", /模型来源: project override/);
});

test("project-aware /history accepts optional project alias and positive limit", async () => {
  const projectManager = new FakeProjectManager();
  const sage = await projectManager.session("SageTalk");
  sage.history.push(
    { role: "user", content: "first", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "second", timestamp: "2026-01-01T00:01:00.000Z" },
    { role: "user", content: "third", timestamp: "2026-01-01T00:02:00.000Z" },
  );

  const result = await routeCommand({ text: "/history SageTalk 2", projectManager, boundUserId: "user-1" });
  const invalid = await routeCommand({ text: "/history bridge nope", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.doesNotMatch(result.reply ?? "", /first/);
  assert.match(result.reply ?? "", /second/);
  assert.match(result.reply ?? "", /third/);
  assert.match(result.reply ?? "", /SageTalk/);
  assert.equal(invalid.handled, true);
  assert.match(invalid.reply ?? "", /正整数/);
});

test("project-aware /history treats a lone numeric alias as active-project limit", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.addProject("2", "/tmp/two");
  const bridge = await projectManager.session("bridge");
  const numeric = await projectManager.session("2");
  bridge.history.push(
    { role: "user", content: "active first", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "active second", timestamp: "2026-01-01T00:01:00.000Z" },
    { role: "user", content: "active third", timestamp: "2026-01-01T00:02:00.000Z" },
  );
  numeric.history.push(
    { role: "user", content: "numeric first", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "numeric second", timestamp: "2026-01-01T00:01:00.000Z" },
  );

  const activeLimit = await routeCommand({ text: "/history 2", projectManager, boundUserId: "user-1" });
  const numericAliasLimit = await routeCommand({ text: "/history 2 1", projectManager, boundUserId: "user-1" });

  assert.equal(activeLimit.handled, true);
  assert.match(activeLimit.reply ?? "", /项目 bridge 历史/);
  assert.doesNotMatch(activeLimit.reply ?? "", /active first/);
  assert.match(activeLimit.reply ?? "", /active second/);
  assert.match(activeLimit.reply ?? "", /active third/);
  assert.doesNotMatch(activeLimit.reply ?? "", /numeric/);
  assert.equal(numericAliasLimit.handled, true);
  assert.match(numericAliasLimit.reply ?? "", /项目 2 历史/);
  assert.doesNotMatch(numericAliasLimit.reply ?? "", /numeric first/);
  assert.match(numericAliasLimit.reply ?? "", /numeric second/);
});

test("project-aware /mode shows active mode and mutates only targeted projects", async () => {
  const projectManager = new FakeProjectManager();

  const show = await routeCommand({ text: "/mode", projectManager, boundUserId: "user-1" });
  const targeted = await routeCommand({ text: "/mode SageTalk workspace", projectManager, boundUserId: "user-1" });
  const invalid = await routeCommand({ text: "/mode SageTalk auto", projectManager, boundUserId: "user-1" });

  assert.equal(show.handled, true);
  assert.match(show.reply ?? "", /当前项目: bridge/);
  assert.match(show.reply ?? "", /当前模式: readonly/);
  assert.equal((await projectManager.session("SageTalk")).mode, "workspace");
  assert.match(targeted.reply ?? "", /SageTalk/);
  assert.equal((await projectManager.session("bridge")).mode, "readonly");
  assert.equal((await projectManager.session("SageTalk")).mode, "workspace");
  assert.match(invalid.reply ?? "", /未知模式/);
});

test("project-aware /mode lets valid mode values win over matching aliases when unambiguous", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.addProject("workspace", "/tmp/workspace");
  await projectManager.setMode("workspace", "yolo");

  const activeMode = await routeCommand({ text: "/mode workspace", projectManager, boundUserId: "user-1" });
  const targetedAlias = await routeCommand({ text: "/mode workspace readonly", projectManager, boundUserId: "user-1" });

  assert.equal(activeMode.handled, true);
  assert.equal((await projectManager.session("bridge")).mode, "workspace");
  assert.match(activeMode.reply ?? "", /项目 bridge 模式已切换为: workspace/);
  assert.equal(targetedAlias.handled, true);
  assert.equal((await projectManager.session("workspace")).mode, "readonly");
  assert.match(targetedAlias.reply ?? "", /项目 workspace 模式已切换为: readonly/);
});

test("project-aware /model changes only when a non-empty model name is provided", async () => {
  const projectManager = new FakeProjectManager();
  await projectManager.setModel("SageTalk", "sage-model");

  const show = await routeCommand({ text: "/model SageTalk", projectManager, boundUserId: "user-1" });
  const set = await routeCommand({ text: "/model SageTalk gpt-5.4-codex", projectManager, boundUserId: "user-1" });

  assert.equal(show.handled, true);
  assert.match(show.reply ?? "", /sage-model/);
  assert.equal((await projectManager.session("SageTalk")).model, "gpt-5.4-codex");
  assert.match(set.reply ?? "", /gpt-5.4-codex/);
  const whitespace = await routeCommand({ text: "/model SageTalk     ", projectManager, boundUserId: "user-1" });
  assert.equal((await projectManager.session("SageTalk")).model, "gpt-5.4-codex");
  assert.match(whitespace.reply ?? "", /gpt-5.4-codex/);
});

test("project-aware /model without args shows effective model and source", async () => {
  const projectManager = new FakeProjectManager();
  const modelService = new FakeModelService();

  const show = await routeCommand({ text: "/model", projectManager, modelService, boundUserId: "user-1" });

  assert.equal(show.handled, true);
  assert.match(show.reply ?? "", /当前项目: bridge/);
  assert.match(show.reply ?? "", /当前模型: gpt-default/);
  assert.match(show.reply ?? "", /模型来源: codex config/);
});

test("project-aware /model preserves alias-only project query behavior", async () => {
  const projectManager = new FakeProjectManager();
  await projectManager.setModel("SageTalk", "sage-model");

  const show = await routeCommand({ text: "/model SageTalk", projectManager, boundUserId: "user-1" });

  assert.equal(show.handled, true);
  assert.match(show.reply ?? "", /当前项目: SageTalk/);
  assert.match(show.reply ?? "", /sage-model/);
  assert.equal((await projectManager.session("bridge")).model, undefined);
});

test("/models lists sanitized catalog details", async () => {
  const modelService = new FakeModelService();

  const result = await routeCommand({ text: "/models", session: createSession("/tmp/bridge"), modelService, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /gpt-5\.5/);
  assert.match(result.reply ?? "", /GPT-5\.5/);
  assert.match(result.reply ?? "", /medium/);
});

test("/models failures return a user-facing message", async () => {
  const modelService = new FakeModelService();
  modelService.failure = new Error("catalog unavailable");

  const result = await routeCommand({ text: "/models", session: createSession("/tmp/bridge"), modelService, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /^无法读取 Codex 模型目录: catalog unavailable/);
});

test("project-aware /clear clears the targeted project", async () => {
  const projectManager = new FakeProjectManager();
  const sage = await projectManager.session("SageTalk");
  sage.history.push({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" });
  sage.codexSessionId = "session-1";

  const result = await routeCommand({ text: "/clear SageTalk", projectManager, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.deepEqual(projectManager.clears, ["SageTalk"]);
  assert.equal((await projectManager.session("SageTalk")).history.length, 0);
});

test("project-aware commands reply clearly for unknown explicit project aliases", async () => {
  const projectManager = new FakeProjectManager();

  for (const text of [
    "/project Missing",
    "/interrupt Missing",
    "/status Missing",
    "/clear Missing",
    "/mode Missing workspace",
    "/model Missing gpt-5",
    "/history Missing 2",
  ]) {
    const result = await routeCommand({ text, projectManager, boundUserId: "user-1" });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /未知项目: Missing/);
    assert.match(result.reply ?? "", /bridge/);
    assert.match(result.reply ?? "", /SageTalk/);
  }
});

test("project-aware /cwd lists configured projects and switches only by matching configured realpath", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-project-")));
  const other = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-project-")));
  const outside = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-outside-")));
  const projectManager = new FakeProjectManager();
  projectManager.sessions.get("bridge")!.cwd = root;
  projectManager.sessions.get("SageTalk")!.cwd = other;

  const list = await routeCommand({ text: "/cwd", projectManager, boundUserId: "user-1" });
  const switched = await routeCommand({ text: `/cwd ${other}`, projectManager, boundUserId: "user-1" });
  const rejected = await routeCommand({ text: `/cwd ${outside}`, projectManager, boundUserId: "user-1" });

  assert.equal(list.handled, true);
  assert.match(list.reply ?? "", new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(list.reply ?? "", /SageTalk/);
  assert.equal(switched.handled, true);
  assert.equal(projectManager.activeProjectAlias, "SageTalk");
  assert.match(rejected.reply ?? "", /未配置|configured/i);
  assert.equal(projectManager.activeProjectAlias, "SageTalk");

  await rm(root, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("project-aware /cwd expands home paths and resolves relative paths before matching configured realpaths", async () => {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const fakeHome = await realpath(mkdtempSync(join(tmpdir(), "wcb-home-")));
  const relativeRoot = await realpath(mkdtempSync(join(tmpdir(), "wcb-relative-")));
  const homeProject = join(fakeHome, "home-project");
  const relativeProject = join(relativeRoot, "relative-project");
  mkdirSync(homeProject);
  mkdirSync(relativeProject);
  const projectManager = new FakeProjectManager();
  projectManager.sessions.get("bridge")!.cwd = await realpath(homeProject);
  projectManager.sessions.get("SageTalk")!.cwd = await realpath(relativeProject);

  try {
    process.env.HOME = fakeHome;
    const homeSwitched = await routeCommand({ text: "/cwd ~/home-project", projectManager, boundUserId: "user-1" });
    assert.equal(homeSwitched.handled, true);
    assert.equal(projectManager.activeProjectAlias, "bridge");
    assert.match(homeSwitched.reply ?? "", /bridge/);

    process.chdir(relativeRoot);
    const relativeSwitched = await routeCommand({ text: "/cwd relative-project", projectManager, boundUserId: "user-1" });

    assert.equal(relativeSwitched.handled, true);
    assert.equal(projectManager.activeProjectAlias, "SageTalk");
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(fakeHome, { recursive: true, force: true });
    await rm(relativeRoot, { recursive: true, force: true });
  }
});

test("project-aware /cwd skips broken configured project cwd while looking for a match", async () => {
  const missing = join(tmpdir(), `wcb-missing-${Date.now()}`);
  const other = await realpath(mkdtempSync(join(tmpdir(), "wcb-cmd-project-")));
  const projectManager = new FakeProjectManager();
  projectManager.sessions.get("bridge")!.cwd = missing;
  projectManager.sessions.get("SageTalk")!.cwd = other;

  const switched = await routeCommand({ text: `/cwd ${other}`, projectManager, boundUserId: "user-1" });

  assert.equal(switched.handled, true);
  assert.equal(projectManager.activeProjectAlias, "SageTalk");
  assert.doesNotMatch(switched.reply ?? "", /命令执行失败/);

  await rm(other, { recursive: true, force: true });
});
