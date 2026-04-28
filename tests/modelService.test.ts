import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
