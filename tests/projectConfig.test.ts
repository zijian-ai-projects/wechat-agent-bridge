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
