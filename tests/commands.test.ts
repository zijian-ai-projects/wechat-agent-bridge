import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { routeCommand } from "../src/commands/router.js";
import type { BridgeSession } from "../src/session/types.js";

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
