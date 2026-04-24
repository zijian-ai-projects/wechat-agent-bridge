import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRuntimeState, saveRuntimeState } from "../src/config/runtimeState.js";

test("runtime state persists lastProject separately from config", async () => {
  const previousHome = process.env.WECHAT_AGENT_BRIDGE_HOME;
  const home = await realpath(mkdtempSync(join(tmpdir(), "wcb-runtime-state-")));
  process.env.WECHAT_AGENT_BRIDGE_HOME = home;

  try {
    assert.deepEqual(loadRuntimeState(), {});

    saveRuntimeState({ lastProject: "SageTalk" });

    assert.deepEqual(loadRuntimeState(), { lastProject: "SageTalk" });
  } finally {
    if (previousHome === undefined) {
      delete process.env.WECHAT_AGENT_BRIDGE_HOME;
    } else {
      process.env.WECHAT_AGENT_BRIDGE_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
