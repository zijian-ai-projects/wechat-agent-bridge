import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logging/logger.js";

test("logger writes redacted log lines and rotates old bridge logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-logs-"));
  const logger = createLogger({ logDir: dir, maxLogFiles: 2 });

  logger.info("token check", { botToken: "secret-token", authorization: "Bearer secret-auth" });
  const log = readFileSync(join(dir, `bridge-${new Date().toISOString().slice(0, 10)}.log`), "utf8");

  assert.match(log, /token check/);
  assert.doesNotMatch(log, /secret-token/);
  assert.doesNotMatch(log, /secret-auth/);

  await rm(dir, { recursive: true, force: true });
});
