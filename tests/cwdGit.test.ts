import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { assertGitRepo, resolveAllowedRepoRoot } from "../src/config/git.js";
import { routeCommand } from "../src/commands/router.js";
import type { BridgeSession } from "../src/session/types.js";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

function session(root: string): BridgeSession {
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

test("assertGitRepo returns understandable error for non Git cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-non-git-"));
  await assert.rejects(assertGitRepo(dir), /不是 Git repo|not a Git repo/i);
  await rm(dir, { recursive: true, force: true });
});

test("resolveAllowedRepoRoot only accepts exact allowlisted repo roots", async () => {
  const repo = await makeGitRepo("wcb-repo-");
  const child = join(repo, "child");
  mkdirSync(child);

  assert.equal(await resolveAllowedRepoRoot(repo, [repo]), await realpath(repo));
  await assert.rejects(resolveAllowedRepoRoot(child, [repo]), /allowlist repo root|允许的 repo root/);

  await rm(repo, { recursive: true, force: true });
});

test("/cwd rejects non-allowlisted or non-root paths with clear WeChat message", async () => {
  const repo = await makeGitRepo("wcb-repo-");
  const child = join(repo, "child");
  mkdirSync(child);
  const s = session(repo);

  const rejected = await routeCommand({ text: `/cwd ${child}`, session: s, boundUserId: "user-1" });

  assert.equal(rejected.handled, true);
  assert.match(rejected.reply ?? "", /无法切换目录/);
  assert.match(rejected.reply ?? "", /repo root|允许/);
  assert.equal(s.cwd, repo);

  await rm(repo, { recursive: true, force: true });
});
