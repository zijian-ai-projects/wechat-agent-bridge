import test from "node:test";
import assert from "node:assert/strict";

import { checkCodexLoginStatus } from "../src/config/codexAuth.js";
import { checkCodexInstalled } from "../src/runtime/codexAvailability.js";
import { codexCommandCandidates, defaultCodexCommand } from "../src/runtime/codexCommand.js";

function enoent(command: string): NodeJS.ErrnoException {
  const error = new Error(`spawnSync ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

test("codex command candidates prefer Windows shims and allow explicit override", () => {
  assert.deepEqual(codexCommandCandidates({ platform: "win32", env: {} }), [
    "codex.cmd",
    "codex.exe",
    "codex.bat",
    "codex",
  ]);
  assert.equal(defaultCodexCommand({ platform: "win32", env: {} }), "codex.cmd");
  assert.deepEqual(codexCommandCandidates({ platform: "linux", env: {} }), ["codex"]);
  assert.deepEqual(codexCommandCandidates({ platform: "win32", env: { WECHAT_AGENT_BRIDGE_CODEX_BIN: "C:\\Codex\\codex.exe" } }), [
    "C:\\Codex\\codex.exe",
  ]);
});

test("checkCodexInstalled falls back to codex.cmd after codex ENOENT", () => {
  const calls: string[] = [];

  const result = checkCodexInstalled({
    candidates: ["codex", "codex.cmd"],
    spawnSync: (command) => {
      calls.push(command);
      if (command === "codex") return { status: null, stdout: "", stderr: "", error: enoent(command) };
      return { status: 0, stdout: "codex 0.125.0\n", stderr: "" };
    },
  });

  assert.deepEqual(calls, ["codex", "codex.cmd"]);
  assert.deepEqual(result, { ok: true, version: "codex 0.125.0", command: "codex.cmd" });
});

test("checkCodexLoginStatus falls back to codex.cmd after codex ENOENT", () => {
  const calls: string[] = [];

  const status = checkCodexLoginStatus({
    candidates: ["codex", "codex.cmd"],
    spawnSync: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codex") return { status: null, stdout: "", stderr: "", error: enoent(command) };
      return { status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
    },
  });

  assert.deepEqual(calls, ["codex login status", "codex.cmd login status"]);
  assert.deepEqual(status, { state: "chatgpt", message: "Logged in using ChatGPT" });
});
