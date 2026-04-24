import assert from "node:assert/strict";
import test from "node:test";

import { runSetupFlow } from "../src/setup/flow.js";

test("runSetupFlow saves projectsRoot and defaultProject from discovered children", async () => {
  const prompts = ["/tmp/projects", "2"];
  const saved: unknown[] = [];
  const inits: string[] = [];
  let binds = 0;

  const summary = await runSetupFlow({
    currentConfig: { defaultProject: "bridge", streamIntervalMs: 10_000, extraWritableRoots: [] },
    bindWechat: async () => {
      binds += 1;
      return { boundUserId: "user-1" };
    },
    ask: async () => prompts.shift() ?? "",
    resolveProjectsRoot: async (input) => input,
    discoverProjects: async () => [
      { alias: "bridge", cwd: "/tmp/projects/bridge", ready: true },
      { alias: "SageTalk", cwd: "/tmp/projects/SageTalk", ready: true },
    ],
    saveConfig: (config) => {
      saved.push(config);
    },
    initGitRepo: async (cwd) => {
      inits.push(cwd);
    },
  });

  assert.equal(binds, 1);
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
    initGitRepo: async (cwd) => {
      inits.push(cwd);
    },
  });

  assert.deepEqual(inits, ["/tmp/projects/scratch"]);
});

test("runSetupFlow aborts when git init is declined for a non-repo default project", async () => {
  const prompts = ["/tmp/projects", "1", "n"];
  const inits: string[] = [];
  const saved: unknown[] = [];

  await assert.rejects(
    runSetupFlow({
      currentConfig: { defaultProject: "scratch", streamIntervalMs: 5_000, extraWritableRoots: [] },
      bindWechat: async () => ({ boundUserId: "user-1" }),
      ask: async () => prompts.shift() ?? "",
      resolveProjectsRoot: async (input) => input,
      discoverProjects: async () => [{ alias: "scratch", cwd: "/tmp/projects/scratch", ready: false }],
      saveConfig: (config) => {
        saved.push(config);
      },
      initGitRepo: async (cwd) => {
        inits.push(cwd);
      },
    }),
    /Git 仓库/,
  );

  assert.deepEqual(inits, []);
  assert.deepEqual(saved, []);
});

test("runSetupFlow re-prompts for projectsRoot when the chosen directory has no child projects", async () => {
  const prompts = ["/tmp/empty", "/tmp/projects", "1"];
  const asked: string[] = [];
  const saved: unknown[] = [];

  await runSetupFlow({
    currentConfig: { defaultProject: "bridge", streamIntervalMs: 10_000, extraWritableRoots: [] },
    bindWechat: async () => ({ boundUserId: "user-1" }),
    ask: async (prompt) => {
      asked.push(prompt);
      return prompts.shift() ?? "";
    },
    resolveProjectsRoot: async (input) => input,
    discoverProjects: async (projectsRoot) =>
      projectsRoot === "/tmp/empty"
        ? []
        : [{ alias: "bridge", cwd: "/tmp/projects/bridge", ready: true }],
    saveConfig: (config) => {
      saved.push(config);
    },
    initGitRepo: async () => {},
  });

  assert.deepEqual(saved, [{ projectsRoot: "/tmp/projects", defaultProject: "bridge", streamIntervalMs: 10_000 }]);
  assert.equal(asked.filter((prompt) => prompt.startsWith("项目根目录")).length, 2);
});

test("runSetupFlow re-prompts when default project selection is invalid", async () => {
  const prompts = ["/tmp/projects", "9", "2"];
  const asked: string[] = [];
  const saved: unknown[] = [];

  await runSetupFlow({
    currentConfig: { defaultProject: "bridge", streamIntervalMs: 10_000, extraWritableRoots: [] },
    bindWechat: async () => ({ boundUserId: "user-1" }),
    ask: async (prompt) => {
      asked.push(prompt);
      return prompts.shift() ?? "";
    },
    resolveProjectsRoot: async (input) => input,
    discoverProjects: async () => [
      { alias: "bridge", cwd: "/tmp/projects/bridge", ready: true },
      { alias: "SageTalk", cwd: "/tmp/projects/SageTalk", ready: true },
    ],
    saveConfig: (config) => {
      saved.push(config);
    },
    initGitRepo: async () => {},
  });

  assert.deepEqual(saved, [{ projectsRoot: "/tmp/projects", defaultProject: "SageTalk", streamIntervalMs: 10_000 }]);
  assert.equal(asked.filter((prompt) => prompt.startsWith("选择默认项目")).length, 2);
});
