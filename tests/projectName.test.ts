import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { APP_NAME, getAttachSocketPath, getDataDir } from "../src/config/paths.js";

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
  assert.equal((packageJson.scripts as Record<string, string>).attach, "tsx src/main.ts attach");
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

test("attach socket uses a Windows named pipe instead of a filesystem socket on Windows", () => {
  const socketPath = getAttachSocketPath({
    platform: "win32",
    dataDir: "C:\\Users\\zijian\\.wechat-agent-bridge",
  });

  assert.match(socketPath, /^\\\\\.\\pipe\\wechat-agent-bridge-[a-f0-9]{16}$/);
  assert.doesNotMatch(socketPath, /bridge\.sock$/);
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
  assert.match(readme, /带项目名启动时会先切换到该项目/);
  assert.match(readme, /:model` 不带参数时显示当前项目模型状态/);
  assert.match(readme, /:models/);

  const commands = readFileSync("docs/commands.md", "utf8");
  assert.match(commands, /## \/models/);
  assert.match(commands, /codex debug models/);
  assert.match(commands, /模型来源可能是 `project override`、`codex config` 或 `unresolved`/);

  const integrations = readFileSync("docs/integrations.md", "utf8");
  assert.match(integrations, /wechat-agent-bridge attach <project>/);
  assert.match(integrations, /not the official Codex TUI/);

  const skill = readFileSync("integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md", "utf8");
  assert.match(skill, /## Available MCP Tools/);
  assert.match(skill, /## Local CLI And Chat Commands/);
  assert.match(skill, /wechat-agent-bridge attach \[project\]/);
  assert.match(skill, /\/models` and `:models/);
});
