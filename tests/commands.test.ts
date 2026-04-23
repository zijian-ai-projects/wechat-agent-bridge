import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { routeCommand } from "../src/commands/router.js";
import type { AgentMode } from "../src/backend/AgentBackend.js";
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
  readonly sessions = new Map<string, ProjectSession>();

  constructor() {
    this.sessions.set("bridge", this.createProjectSession("bridge", "/tmp/bridge"));
    this.sessions.set("SageTalk", this.createProjectSession("SageTalk", "/tmp/sage"));
  }

  listProjects(): Array<{ alias: string; cwd: string; active: boolean }> {
    return [bridgeProject.alias, sageProject.alias].map((alias) => ({
      alias,
      cwd: this.sessions.get(alias)!.cwd,
      active: alias === this.activeProjectAlias,
    }));
  }

  setActiveProject(alias: string): { alias: string; cwd: string } {
    const project = this.listProjects().find((item) => item.alias === alias);
    if (!project) throw new Error(`Unknown project: ${alias}`);
    this.activeProjectAlias = alias;
    return { alias: project.alias, cwd: project.cwd };
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

test("/help includes project commands and keeps yolo warning semantics", async () => {
  const session = createSession("/tmp");

  const result = await routeCommand({ text: "/help", session, boundUserId: "user-1" });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /\/project \[alias\]/);
  assert.match(result.reply ?? "", /\/interrupt \[project\]/);
  assert.match(result.reply ?? "", /\/replace \[project\] <prompt>/);
  assert.match(result.reply ?? "", /readonly/);
  assert.match(result.reply ?? "", /\/mode yolo/);
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

test("/interrupt targets active and explicit projects", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.setActiveProject("SageTalk");

  const active = await routeCommand({ text: "/interrupt", projectManager, boundUserId: "user-1" });
  const explicit = await routeCommand({ text: "/interrupt bridge", projectManager, boundUserId: "user-1" });

  assert.equal(active.handled, true);
  assert.equal(explicit.handled, true);
  assert.deepEqual(projectManager.interrupts, [undefined, "bridge"]);
});

test("/replace targets explicit and active projects with WeChat context", async () => {
  const projectManager = new FakeProjectManager();
  projectManager.setActiveProject("SageTalk");

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
  const sage = await projectManager.session("SageTalk");
  sage.state = "processing";
  sage.model = "gpt-sage";
  sage.history.push({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" });

  const overview = await routeCommand({ text: "/status", projectManager, boundUserId: "user-1" });
  const targeted = await routeCommand({ text: "/status SageTalk", projectManager, boundUserId: "user-1" });

  assert.equal(overview.handled, true);
  assert.match(overview.reply ?? "", /项目状态/);
  assert.match(overview.reply ?? "", /\* bridge/);
  assert.match(overview.reply ?? "", /SageTalk.*processing.*gpt-sage/);
  assert.equal(targeted.handled, true);
  assert.match(targeted.reply ?? "", /项目: SageTalk/);
  assert.match(targeted.reply ?? "", /状态: processing/);
  assert.match(targeted.reply ?? "", /历史条数: 1/);
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
