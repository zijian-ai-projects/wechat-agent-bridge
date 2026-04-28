import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelService, parseCodexModelCatalog, parseCodexDefaultModel } from "../src/core/ModelService.js";
import type { ProjectSession } from "../src/session/types.js";

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    userId: "user-1",
    projectAlias: "bridge",
    state: "idle",
    cwd: "/tmp/bridge",
    mode: "readonly",
    history: [],
    allowlistRoots: ["/tmp/bridge"],
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

test("parseCodexDefaultModel reads a top-level model entry", () => {
  assert.equal(parseCodexDefaultModel('model = "gpt-5.5"\n'), "gpt-5.5");
  assert.equal(parseCodexDefaultModel("[profiles.fast]\nmodel = \"gpt-5.4\"\n"), undefined);
});

test("ModelService prefers a project model override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-"));
  writeFileSync(join(dir, "config.toml"), 'model = "gpt-5.4"\n');
  const service = new ModelService({ codexHome: dir });

  const state = await service.describeSession(session({ model: "gpt-5.5" }));

  assert.equal(state.effectiveModel, "gpt-5.5");
  assert.equal(state.source, "project override");
  assert.equal(state.configuredModel, "gpt-5.5");
  assert.equal(state.codexDefaultModel, "gpt-5.4");
});

test("ModelService reports Codex config default when no override exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-"));
  writeFileSync(join(dir, "config.toml"), 'model = "gpt-5.4"\n');
  const service = new ModelService({ codexHome: dir });

  const state = await service.describeSession(session());

  assert.equal(state.effectiveModel, "gpt-5.4");
  assert.equal(state.source, "codex config");
});

test("ModelService falls back to unresolved Codex CLI default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-"));
  const service = new ModelService({ codexHome: dir });

  const state = await service.describeSession(session());

  assert.equal(state.effectiveModel, "Codex CLI default");
  assert.equal(state.source, "unresolved");
});

test("parseCodexModelCatalog ignores warnings and sanitizes raw catalog entries", () => {
  const raw = [
    "WARNING: proceeding",
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Frontier model",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
          base_instructions: "do not expose",
        },
      ],
    }),
  ].join("\n");

  const catalog = parseCodexModelCatalog(raw);

  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]?.slug, "gpt-5.5");
  assert.equal(catalog.models[0]?.displayName, "GPT-5.5");
  assert.equal(catalog.models[0]?.defaultReasoningLevel, "medium");
  assert.deepEqual(catalog.models[0]?.supportedReasoningLevels, [{ effort: "low", description: "Fast" }]);
  assert.equal("base_instructions" in catalog.models[0]!, false);
});

test("parseCodexModelCatalog tolerates malformed catalog shape", () => {
  assert.deepEqual(parseCodexModelCatalog(JSON.stringify({ models: {} })), { models: [] });
  assert.deepEqual(parseCodexModelCatalog(JSON.stringify({ models: [{ slug: "ok", supported_reasoning_levels: [null, "bad"] }] })), {
    models: [{ slug: "ok", supportedReasoningLevels: [] }],
  });
});

test("ModelService listModels invokes codex debug models and parses sanitized output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-bin-"));
  const bin = join(dir, "fake-codex.mjs");
  const argsPath = join(dir, "args.txt");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join(" "));
console.log("WARNING: proceeding");
console.log(JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", base_instructions: "do not expose" }] }));
`,
    { mode: 0o700 },
  );
  const service = new ModelService({ codexBin: bin });

  const catalog = await service.listModels();

  assert.equal(readFileText(argsPath), "debug models");
  assert.deepEqual(catalog.models, [{ slug: "gpt-5.5", displayName: "GPT-5.5" }]);
});

test("ModelService listModels throws sanitized errors for command failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-bin-"));
  const bin = join(dir, "fake-codex.sh");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "SECRET_STDERR" >&2
exit 2
`,
    { mode: 0o700 },
  );
  const service = new ModelService({ codexBin: bin, modelCatalogTimeoutMs: 1000 });

  await assert.rejects(() => service.listModels(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Unable to read Codex model catalog/);
    assert.match(error.message, /exited with code 2/);
    assert.doesNotMatch(error.message, /SECRET_STDERR/);
    return true;
  });
});

test("ModelService listModels times out hung catalog commands and cleans up the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcb-model-bin-"));
  const bin = join(dir, "fake-codex.sh");
  const pidPath = join(dir, "pid.txt");
  writeFileSync(
    bin,
    `#!/bin/sh
echo $$ > ${JSON.stringify(pidPath)}
while true; do sleep 1; done
`,
    { mode: 0o700 },
  );
  const service = new ModelService({ codexBin: bin, modelCatalogTimeoutMs: 1000 });

  await assert.rejects(() => service.listModels(), /timed out after 1000ms/);
  const pid = Number.parseInt(readFileText(pidPath), 10);
  assert.equal(Number.isFinite(pid), true);
  await waitForProcessExit(pid);
});

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (existsSync(`/proc/${pid}`)) {
    assert.fail(`process ${pid} is still running`);
  }
  try {
    process.kill(pid, 0);
    assert.fail(`process ${pid} is still running`);
  } catch {
    return;
  }
}
