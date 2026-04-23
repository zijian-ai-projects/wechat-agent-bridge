import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveSecureJson } from "../src/config/secureStore.js";
import { ProjectSessionStore } from "../src/session/projectSessionStore.js";
import type { ProjectDefinition } from "../src/config/projects.js";
import type { ProjectSession } from "../src/session/types.js";

function project(alias: string, cwd: string): ProjectDefinition {
  return { alias, cwd };
}

test("ProjectSessionStore isolates sessions by user and project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const projectA = project("bridge", join(dir, "bridge"));
    const projectB = project("sage", join(dir, "sage"));

    const userAProjectA = await store.load("user-a", projectA);
    userAProjectA.history.push({ role: "user", content: "bridge history", timestamp: "2026-01-01T00:00:00.000Z" });
    await store.save(userAProjectA);

    const sameUserOtherProject = await store.load("user-a", projectB);
    const otherUserSameProject = await store.load("user-b", projectA);

    assert.equal((await store.load("user-a", projectA)).history.length, 1);
    assert.equal(sameUserOtherProject.history.length, 0);
    assert.equal(otherUserSameProject.history.length, 0);
    assert.equal(userAProjectA.projectAlias, "bridge");
    assert.equal(sameUserOtherProject.projectAlias, "sage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProjectSessionStore resets stale processing per project while preserving codexSessionId and history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const projectA = project("bridge", join(dir, "bridge"));
    const projectB = project("sage", join(dir, "sage"));

    const stale = await store.load("user-a", projectA);
    stale.state = "processing";
    stale.activeTurnId = "turn-a";
    stale.codexSessionId = "codex-a";
    stale.history.push({ role: "assistant", content: "kept", timestamp: "2026-01-01T00:00:00.000Z" });
    await store.save(stale);

    const other = await store.load("user-a", projectB);
    other.state = "processing";
    other.activeTurnId = "turn-b";
    await store.save(other);

    const loaded = await store.load("user-a", projectA, { resetStaleProcessing: true });
    const otherLoaded = await store.load("user-a", projectB);

    assert.equal(loaded.state, "idle");
    assert.equal(loaded.activeTurnId, undefined);
    assert.equal(loaded.codexSessionId, "codex-a");
    assert.equal(loaded.history.length, 1);
    assert.equal(otherLoaded.state, "processing");
    assert.equal(otherLoaded.activeTurnId, "turn-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProjectSessionStore corrects persisted stale cwd and allowlistRoots when project cwd changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const oldCwd = join(dir, "old");
    const newCwd = join(dir, "new");

    const session = await store.load("user-a", project("bridge", oldCwd));
    await store.save(session);

    const loaded = await store.load("user-a", project("bridge", newCwd));

    assert.equal(loaded.userId, "user-a");
    assert.equal(loaded.projectAlias, "bridge");
    assert.equal(loaded.cwd, newCwd);
    assert.deepEqual(loaded.allowlistRoots, [newCwd]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProjectSessionStore trims history to 100 entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const session = await store.load("user-a", project("bridge", join(dir, "bridge")));

    for (let index = 0; index < 105; index += 1) {
      store.addHistory(session, "user", `message ${index}`);
    }
    await store.save(session);

    const loaded = await store.load("user-a", project("bridge", join(dir, "bridge")));

    assert.equal(loaded.history.length, 100);
    assert.equal(loaded.history[0].content, "message 5");
    assert.equal(loaded.history[99].content, "message 104");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProjectSessionStore clear saves and returns a fresh idle readonly project session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const bridge = project("bridge", join(dir, "bridge"));
    const session = await store.load("user-a", bridge);
    session.state = "processing";
    session.mode = "workspace";
    session.codexSessionId = "codex-a";
    session.history.push({ role: "user", content: "discarded", timestamp: "2026-01-01T00:00:00.000Z" });
    await store.save(session);

    const cleared = await store.clear("user-a", bridge);
    const loaded = await store.load("user-a", bridge);

    assert.deepEqual(cleared, loaded);
    assert.equal(cleared.userId, "user-a");
    assert.equal(cleared.projectAlias, "bridge");
    assert.equal(cleared.cwd, bridge.cwd);
    assert.deepEqual(cleared.allowlistRoots, [bridge.cwd]);
    assert.equal(cleared.state, "idle");
    assert.equal(cleared.mode, "readonly");
    assert.equal(cleared.codexSessionId, undefined);
    assert.deepEqual(cleared.history, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProjectSessionStore forces persisted identity and project fields to current values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-project-session-"));
  try {
    const store = new ProjectSessionStore(dir);
    const bridge = project("bridge", join(dir, "bridge"));
    const stale: ProjectSession = {
      userId: "wrong-user",
      projectAlias: "wrong-project",
      state: "idle",
      cwd: join(dir, "wrong-cwd"),
      mode: "readonly",
      history: [],
      allowlistRoots: [join(dir, "wrong-cwd")],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    saveSecureJson(join(dir, "user-a", "bridge.json"), stale);

    const loaded = await store.load("user-a", bridge);

    assert.equal(loaded.userId, "user-a");
    assert.equal(loaded.projectAlias, "bridge");
    assert.equal(loaded.cwd, bridge.cwd);
    assert.deepEqual(loaded.allowlistRoots, [bridge.cwd]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
