import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { APP_NAME, getDataDir } from "../src/config/paths.js";

const PROJECT_NAME = "wechat-agent-bridge";
const OLD_PROJECT_NAME = "wechat-codex-bridge";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("package metadata uses the generic agent bridge name", () => {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.name, PROJECT_NAME);
  assert.deepEqual(packageJson.bin, {
    [PROJECT_NAME]: "./dist/src/main.js",
    [`${PROJECT_NAME}-mcp`]: "./dist/src/mcp-main.js",
  });
});

test("config paths use the new app name while accepting the legacy home env var", () => {
  const oldAgentHome = process.env.WECHAT_AGENT_BRIDGE_HOME;
  const oldCodexHome = process.env.WECHAT_CODEX_BRIDGE_HOME;
  try {
    delete process.env.WECHAT_AGENT_BRIDGE_HOME;
    delete process.env.WECHAT_CODEX_BRIDGE_HOME;
    assert.equal(APP_NAME, PROJECT_NAME);
    assert.equal(getDataDir(), join(homedir(), `.${PROJECT_NAME}`));

    process.env.WECHAT_CODEX_BRIDGE_HOME = "/tmp/legacy-home";
    assert.equal(getDataDir(), "/tmp/legacy-home");

    process.env.WECHAT_AGENT_BRIDGE_HOME = "/tmp/new-home";
    assert.equal(getDataDir(), "/tmp/new-home");
  } finally {
    if (oldAgentHome === undefined) delete process.env.WECHAT_AGENT_BRIDGE_HOME;
    else process.env.WECHAT_AGENT_BRIDGE_HOME = oldAgentHome;
    if (oldCodexHome === undefined) delete process.env.WECHAT_CODEX_BRIDGE_HOME;
    else process.env.WECHAT_CODEX_BRIDGE_HOME = oldCodexHome;
  }
});

test("integration manifests use the agent bridge namespace", () => {
  const plugin = readJson("integrations/codex/plugin/.codex-plugin/plugin.json");
  assert.equal(plugin.name, PROJECT_NAME);

  const mcpTemplate = readFileSync("integrations/codex/plugin/.mcp.json", "utf8");
  assert.match(mcpTemplate, new RegExp(PROJECT_NAME));
  assert.doesNotMatch(mcpTemplate, new RegExp(OLD_PROJECT_NAME));
});
