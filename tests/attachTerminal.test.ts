import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttachTerminalLaunch,
  isAutoAttachEnabled,
  launchAttachTerminal,
  type SpawnAttachTerminal,
} from "../src/ipc/attachTerminal.js";

test("buildAttachTerminalLaunch opens a Windows cmd attach window in the project cwd", () => {
  const launch = buildAttachTerminalLaunch({
    platform: "win32",
    cwd: "C:\\Projects\\wechat-agent-bridge",
  });

  assert.equal(launch?.command, "cmd.exe");
  assert.deepEqual(launch?.args, [
    "/d",
    "/s",
    "/c",
    'start "" /D "C:\\Projects\\wechat-agent-bridge" cmd.exe /k "npm run attach"',
  ]);
});

test("auto attach launch can be disabled for background daemon starts", () => {
  assert.equal(isAutoAttachEnabled({}), true);
  assert.equal(isAutoAttachEnabled({ WECHAT_AGENT_BRIDGE_AUTO_ATTACH: "0" }), false);
});

test("launchAttachTerminal spawns the platform launch command detached", () => {
  const calls: Array<{ command: string; args: string[]; detached?: boolean; cwd?: string }> = [];
  const spawn: SpawnAttachTerminal = (command, args, options) => {
    calls.push({ command, args, detached: options.detached, cwd: options.cwd?.toString() });
    const child = {
      once: () => child,
      unref: () => undefined,
    } as ReturnType<SpawnAttachTerminal>;
    return child;
  };

  const result = launchAttachTerminal({
    platform: "win32",
    cwd: "C:\\Projects\\wechat-agent-bridge",
    env: {},
    spawn,
  });

  assert.equal(result.launched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "cmd.exe");
  assert.equal(calls[0]?.detached, true);
  assert.equal(calls[0]?.cwd, "C:\\Projects\\wechat-agent-bridge");
});
