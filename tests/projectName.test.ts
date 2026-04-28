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

test("documentation covers attach cli and model catalog commands", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /## 桌面同步终端/);
  assert.match(readme, /wechat-agent-bridge attach SageTalk/);
  assert.match(readme, /:models/);

  const commands = readFileSync("docs/commands.md", "utf8");
  assert.match(commands, /## \/models/);
  assert.match(commands, /codex debug models/);
  assert.match(commands, /模型来源可能是项目 override、Codex config 或 Codex CLI default/);

  const integrations = readFileSync("docs/integrations.md", "utf8");
  assert.match(integrations, /wechat-agent-bridge attach <project>/);
  assert.match(integrations, /not the official Codex TUI/);

  const skill = readFileSync("integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md", "utf8");
  assert.match(skill, /wechat-agent-bridge attach \[project\]/);
  assert.match(skill, /\/models` and `:models/);
});
