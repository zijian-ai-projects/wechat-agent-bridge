import test from "node:test";
import assert from "node:assert/strict";

import {
  formatCodexLoginGuidance,
  parseCodexLoginStatus,
} from "../src/config/codexAuth.js";

test("parseCodexLoginStatus distinguishes ChatGPT, API key and logged out states", () => {
  assert.deepEqual(parseCodexLoginStatus({ status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }), {
    state: "chatgpt",
    message: "Logged in using ChatGPT",
  });

  assert.deepEqual(parseCodexLoginStatus({ status: 0, stdout: "Logged in using API key\n", stderr: "" }), {
    state: "api-key",
    message: "Logged in using API key",
  });

  assert.deepEqual(parseCodexLoginStatus({ status: 1, stdout: "", stderr: "Not logged in\n" }), {
    state: "logged-out",
    message: "Not logged in",
  });
});

test("formatCodexLoginGuidance tells user to run codex login without requiring API key", () => {
  const guidance = formatCodexLoginGuidance({ state: "logged-out", message: "Not logged in" });

  assert.match(guidance, /codex login/);
  assert.match(guidance, /codex login --device-auth/);
  assert.doesNotMatch(guidance, /OPENAI_API_KEY.*必须|required/i);
});
