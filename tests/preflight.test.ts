import { mkdtempSync, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runPreflightWithChecks } from "../src/runtime/preflight.js";
import { checkCodexFileAuthPermissions } from "../src/config/codexAuth.js";

async function makeGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wcb-preflight-"));
  mkdirSync(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

test("preflight allows daemon start when codex login status is ChatGPT", async () => {
  const repo = await makeGitRepo();

  const result = await runPreflightWithChecks(
    { defaultCwd: repo, allowlistRoots: [repo], extraWritableRoots: [], streamIntervalMs: 1 },
    {
      checkCodexInstalled: () => ({ ok: true, version: "codex 1.0.0" }),
      checkCodexLoginStatus: () => ({ state: "chatgpt", message: "Logged in using ChatGPT" }),
      checkCodexFileAuthPermissions: () => undefined,
    },
  );

  assert.equal(result.login.state, "chatgpt");
  await rm(repo, { recursive: true, force: true });
});

test("preflight returns clear login guidance when codex is not logged in", async () => {
  const repo = await makeGitRepo();

  await assert.rejects(
    runPreflightWithChecks(
      { defaultCwd: repo, allowlistRoots: [repo], extraWritableRoots: [], streamIntervalMs: 1 },
      {
        checkCodexInstalled: () => ({ ok: true, version: "codex 1.0.0" }),
        checkCodexLoginStatus: () => ({ state: "logged-out", message: "Not logged in" }),
        checkCodexFileAuthPermissions: () => undefined,
      },
    ),
    /codex login[\s\S]*codex login --device-auth/,
  );

  await rm(repo, { recursive: true, force: true });
});

test("file credential mode checks auth.json permissions without reading or leaking content", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "wcb-codex-home-"));
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({ token: "secret-token", refresh_token: "refresh-secret" }), {
    mode: 0o600,
  });

  assert.equal(checkCodexFileAuthPermissions({ CODEX_HOME: codexHome }), join(codexHome, "auth.json"));

  await rm(codexHome, { recursive: true, force: true });
});
