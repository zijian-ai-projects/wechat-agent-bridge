import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config/config.js";
import { getConfigPath } from "../src/config/paths.js";
import { saveSecureJson } from "../src/config/secureStore.js";
import {
  ProjectCatalog,
  createLegacyProjects,
  resolveProjectRegistry,
  resolveProjectsRootConfig,
  validateProjectAlias,
} from "../src/config/projects.js";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

async function makeGitRepoTree(prefix: string): Promise<{ root: string; repo: string }> {
  const root = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { root, repo };
}

async function withTempConfigHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.WECHAT_AGENT_BRIDGE_HOME;
  const home = await realpath(mkdtempSync(join(tmpdir(), "wcb-config-")));
  process.env.WECHAT_AGENT_BRIDGE_HOME = home;
  try {
    return await body(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.WECHAT_AGENT_BRIDGE_HOME;
    } else {
      process.env.WECHAT_AGENT_BRIDGE_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("validateProjectAlias accepts safe aliases and rejects path-like aliases", () => {
  assert.equal(validateProjectAlias("SageTalk"), "SageTalk");
  assert.equal(validateProjectAlias("bridge-main"), "bridge-main");
  assert.throws(() => validateProjectAlias("../escape"), /Invalid project alias/);
  assert.throws(() => validateProjectAlias("bad name"), /Invalid project alias/);
});

test("loadConfig preserves the new projectsRoot config shape and resolves the default cwd", async () => {
  await withTempConfigHome(async () => {
    const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-")));
    const bridge = join(root, "bridge");
    const sage = join(root, "SageTalk");
    mkdirSync(join(bridge, ".git"), { recursive: true });
    mkdirSync(join(sage, ".git"), { recursive: true });
    await writeFile(join(bridge, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(sage, ".git", "HEAD"), "ref: refs/heads/main\n");

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
      assert.equal(config.defaultCwd, sage);
      assert.deepEqual(config.allowlistRoots, [sage]);
      assert.deepEqual(config.extraWritableRoots, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("loadConfig preserves an explicit defaultProject even when it is invalid", async () => {
  await withTempConfigHome(async () => {
    const bridge = await makeGitRepo("wcb-bridge-");
    try {
      saveSecureJson(getConfigPath(), {
        defaultCwd: bridge,
        allowlistRoots: [bridge],
        defaultProject: "missing",
        projects: {
          bridge: { cwd: bridge },
        },
        extraWritableRoots: [],
        streamIntervalMs: 1,
      });

      const config = loadConfig();
      assert.equal(config.defaultProject, "missing");
      await assert.rejects(resolveProjectRegistry(config), /Default project does not exist: missing/);
    } finally {
      await rm(bridge, { recursive: true, force: true });
    }
  });
});

test("loadConfig preserves explicit empty projects without falling back to legacy config", async () => {
  await withTempConfigHome(async () => {
    const bridge = await makeGitRepo("wcb-bridge-");
    try {
      saveSecureJson(getConfigPath(), {
        defaultCwd: bridge,
        allowlistRoots: [bridge],
        defaultProject: "bridge",
        projects: {},
        extraWritableRoots: [],
        streamIntervalMs: 1,
      });

      const config = loadConfig();
      assert.deepEqual(config.projects, {});
      await assert.rejects(resolveProjectRegistry(config), /No projects configured\./);
    } finally {
      await rm(bridge, { recursive: true, force: true });
    }
  });
});

test("loadConfig normalizes legacy fields from an explicit default project", async () => {
  await withTempConfigHome(async () => {
    const repoA = await makeGitRepo("wcb-a-");
    const repoB = await makeGitRepo("wcb-b-");
    try {
      saveSecureJson(getConfigPath(), {
        defaultCwd: repoA,
        allowlistRoots: [repoA],
        defaultProject: "sage",
        projects: {
          bridge: { cwd: repoA },
          sage: { cwd: repoB },
        },
        extraWritableRoots: [],
        streamIntervalMs: 1,
      });

      const config = loadConfig();
      assert.equal(config.defaultProject, "sage");
      assert.equal(config.defaultCwd, repoB);
      assert.deepEqual(new Set(config.allowlistRoots), new Set([repoA, repoB]));
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  });
});

test("createLegacyProjects sanitizes legacy aliases and resolves collisions", () => {
  const projects = createLegacyProjects("/tmp/wechat-agent-bridge", [
    "/tmp/foo.bar",
    "/tmp/foo bar",
    "/tmp/.config",
    "/tmp/项目",
  ]);

  assert.equal(projects.projects["foo-bar"].cwd, "/tmp/foo.bar");
  assert.equal(projects.projects["foo-bar-2"].cwd, "/tmp/foo bar");
  assert.equal(projects.projects.config.cwd, "/tmp/.config");
  assert.equal(projects.projects.project.cwd, "/tmp/项目");
});

test("createLegacyProjects avoids prototype-name collisions", () => {
  const projects = createLegacyProjects("/tmp/wechat-agent-bridge", ["/tmp/constructor", "/tmp/toString"]);

  assert.equal(projects.projects["constructor"].cwd, "/tmp/constructor");
  assert.equal(projects.projects["toString"].cwd, "/tmp/toString");
});

test("createLegacyProjects derives aliases from allowlist roots", () => {
  const projects = createLegacyProjects("/tmp/wechat-agent-bridge", ["/tmp/wechat-agent-bridge", "/tmp/SageTalk"]);

  assert.equal(projects.defaultProject, basename("/tmp/wechat-agent-bridge"));
  assert.equal(projects.projects["wechat-agent-bridge"].cwd, "/tmp/wechat-agent-bridge");
  assert.equal(projects.projects.SageTalk.cwd, "/tmp/SageTalk");
});

test("resolveProjectRegistry canonicalizes whitespace and relative cwd values", async () => {
  const { root, repo } = await makeGitRepoTree("wcb-tree-");
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const registry = await resolveProjectRegistry({
      defaultProject: "repo",
      projects: {
        repo: { cwd: "  ./repo  " },
      },
    });

    assert.equal(registry.defaultProject.cwd, repo);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectRegistry rejects duplicate realpaths", async () => {
  const bridge = await makeGitRepo("wcb-bridge-");
  const alias = await makeGitRepo("wcb-alias-");

  try {
    await assert.rejects(
      resolveProjectRegistry({
        defaultProject: "bridge",
        projects: {
          bridge: { cwd: join(bridge, "nested", "..") },
          alias: { cwd: bridge },
        },
      }),
      /resolve to the same cwd/,
    );
  } finally {
    await rm(bridge, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  }
});

test("resolveProjectRegistry rejects missing, non-root, and nonexistent project cwd values", async () => {
  const bridge = await makeGitRepo("wcb-bridge-");
  const nested = join(bridge, "nested");
  mkdirSync(nested, { recursive: true });

  try {
    await assert.rejects(
      resolveProjectRegistry({
        defaultProject: "bridge",
        projects: {
          bridge: { cwd: bridge },
          nested: { cwd: nested },
        },
      }),
      /must be a Git repo root/,
    );

    await assert.rejects(
      resolveProjectRegistry({
        defaultProject: "missing",
        projects: {
          bridge: { cwd: bridge },
        },
      }),
      /Default project does not exist: missing/,
    );

    await assert.rejects(
      resolveProjectRegistry({
        defaultProject: "bridge",
        projects: {
          bridge: { cwd: join(bridge, "does-not-exist") },
        },
      }),
      /ENOENT|no such file/i,
    );
  } finally {
    await rm(bridge, { recursive: true, force: true });
  }
});

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

test("resolveProjectsRootConfig prefers explicit projectsRoot and infers it from legacy config", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-legacy-root-")));
  const bridge = join(root, "bridge");
  const sage = join(root, "SageTalk");
  mkdirSync(join(bridge, ".git"), { recursive: true });
  mkdirSync(join(sage, ".git"), { recursive: true });
  await writeFile(join(bridge, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(sage, ".git", "HEAD"), "ref: refs/heads/main\n");

  try {
    const explicit = await resolveProjectsRootConfig({
      projectsRoot: root,
      defaultProject: "SageTalk",
      defaultCwd: sage,
      allowlistRoots: [sage],
      extraWritableRoots: [],
      streamIntervalMs: 10_000,
      projects: undefined,
    });
    assert.equal(explicit.projectsRoot, root);
    assert.equal(explicit.defaultProject, "SageTalk");

    const inferred = await resolveProjectsRootConfig({
      defaultProject: "SageTalk",
      defaultCwd: sage,
      allowlistRoots: [sage],
      extraWritableRoots: [],
      streamIntervalMs: 10_000,
      projects: {
        bridge: { cwd: bridge },
        SageTalk: { cwd: sage },
      },
    });
    assert.equal(inferred.projectsRoot, root);
    assert.equal(inferred.defaultProject, "SageTalk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveProjectsRootConfig rejects legacy config that spans multiple parents", async () => {
  const rootA = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-a-")));
  const rootB = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-b-")));
  const bridge = join(rootA, "bridge");
  const sage = join(rootB, "SageTalk");
  mkdirSync(join(bridge, ".git"), { recursive: true });
  mkdirSync(join(sage, ".git"), { recursive: true });
  await writeFile(join(bridge, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(sage, ".git", "HEAD"), "ref: refs/heads/main\n");

  try {
    await assert.rejects(
      resolveProjectsRootConfig({
        defaultProject: "bridge",
        defaultCwd: bridge,
        allowlistRoots: [bridge],
        extraWritableRoots: [],
        streamIntervalMs: 10_000,
        projects: {
          bridge: { cwd: bridge },
          SageTalk: { cwd: sage },
        },
      }),
      /npm run setup/i,
    );
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});
