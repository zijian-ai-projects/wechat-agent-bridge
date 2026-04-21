import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { FileSessionStore } from "../src/session/sessionStore.js";

test("FileSessionStore isolates sessions by bound user and resets stale processing state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-session-"));
  const store = new FileSessionStore(dir);

  const session = await store.load("user-a", {
    cwd: dir,
    allowlistRoots: [dir],
  });
  session.state = "processing";
  session.codexSessionId = "thread-a";
  session.history.push({ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" });
  await store.save(session);

  const loaded = await store.load("user-a", {
    cwd: dir,
    allowlistRoots: [dir],
    resetStaleProcessing: true,
  });
  const other = await store.load("user-b", {
    cwd: dir,
    allowlistRoots: [dir],
  });

  assert.equal(loaded.state, "idle");
  assert.equal(loaded.codexSessionId, "thread-a");
  assert.equal(loaded.history.length, 1);
  assert.equal(other.history.length, 0);

  await rm(dir, { recursive: true, force: true });
});
