import { mkdtempSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../src/logging/redact.js";
import { saveSecureJson } from "../src/config/secureStore.js";
import { isDirectBoundUserMessage, resolveAllowedCwd } from "../src/config/security.js";

test("resolveAllowedCwd accepts only real paths under allowlist roots", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-")));
  const project = join(root, "project");
  mkdirSync(project);

  assert.equal(await resolveAllowedCwd(project, [root]), await realpath(project));

  await assert.rejects(
    resolveAllowedCwd(tmpdir(), [root]),
    /not within an allowed root/,
  );

  await rm(root, { recursive: true, force: true });
});

test("resolveAllowedCwd rejects symlink escapes", async () => {
  const root = await realpath(mkdtempSync(join(tmpdir(), "wcb-root-")));
  const outside = await realpath(mkdtempSync(join(tmpdir(), "wcb-outside-")));
  const link = join(root, "escape");
  symlinkSync(outside, link);

  await assert.rejects(
    resolveAllowedCwd(link, [root]),
    /not within an allowed root/,
  );

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("redactSecrets removes tokens, cookies and authorization headers", () => {
  const input = {
    authorization: "Bearer abc.def.ghi",
    cookie: "sessionid=secret; wx=token",
    botToken: "wx-token-123",
    auth: "auth-secret",
    refresh_token: "refresh-secret",
    nested: "Authorization: Bearer raw-token-value",
  };

  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /abc\.def\.ghi/);
  assert.doesNotMatch(redacted, /sessionid=secret/);
  assert.doesNotMatch(redacted, /wx-token-123/);
  assert.doesNotMatch(redacted, /auth-secret/);
  assert.doesNotMatch(redacted, /refresh-secret/);
  assert.match(redacted, /\*\*\*/);
});

test("saveSecureJson writes private account files with mode 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-secure-"));
  const file = join(dir, "account.json");

  saveSecureJson(file, { botToken: "secret" });
  assert.deepEqual(JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"))), {
    botToken: "secret",
  });

  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }

  await rm(dir, { recursive: true, force: true });
});

test("isDirectBoundUserMessage ignores groups, bots and non-bound users", () => {
  assert.equal(isDirectBoundUserMessage({ fromUserId: "user-1", boundUserId: "user-1", messageType: 1 }), true);
  assert.equal(isDirectBoundUserMessage({ fromUserId: "user-2", boundUserId: "user-1", messageType: 1 }), false);
  assert.equal(isDirectBoundUserMessage({ fromUserId: "room@chatroom", boundUserId: "room@chatroom", messageType: 1 }), false);
  assert.equal(isDirectBoundUserMessage({ fromUserId: "user-1", boundUserId: "user-1", messageType: 2 }), false);
});
