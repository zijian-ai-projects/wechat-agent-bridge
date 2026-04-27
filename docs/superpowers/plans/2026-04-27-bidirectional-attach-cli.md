# Bidirectional Attach CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `wechat-agent-bridge attach [project]` terminal frontend that mirrors the same bridge-managed project turns as WeChat, and expose explicit model status/list/switching from both frontends.

**Architecture:** Keep the daemon as the only executor. Add a small in-process event bus, a local Unix-socket JSONL attach server/client pair, and a model service that resolves project overrides plus best-effort Codex defaults/catalogs. Route both WeChat and attach prompts through `ProjectRuntimeManager`, then broadcast user messages, turn lifecycle, Codex formatted events, and state updates to all connected frontends.

**Tech Stack:** Node.js 20, TypeScript ESM, `node:test`, Unix domain sockets via `node:net`, child processes via `node:child_process`, existing Codex CLI backend.

---

## File Structure

- Create `src/core/EventBus.ts`: typed process-local event bus for bridge events.
- Create `src/core/ModelService.ts`: model state, Codex config parsing, and sanitized `codex debug models` catalog access.
- Create `src/ipc/protocol.ts`: attach JSONL message/event types and parser/serializer helpers.
- Create `src/ipc/attachCommands.ts`: parse attach terminal input into protocol messages.
- Create `src/ipc/AttachServer.ts`: daemon-side socket server, client management, command dispatch, and event fan-out.
- Create `src/ipc/AttachClient.ts`: terminal-side socket client, stdin handling, and event rendering.
- Modify `src/config/paths.ts`: add `getAttachSocketPath()`.
- Modify `src/core/ProjectRuntime.ts`: publish turn lifecycle, formatted Codex events, and state updates.
- Modify `src/core/ProjectRuntimeManager.ts`: accept event bus/model service and publish user-message events after project resolution.
- Modify `src/core/BridgeService.ts`: pass prompt source as `wechat`.
- Modify `src/runtime/bridge.ts`: construct shared event bus/model service, start/stop attach server, and mirror attach-origin prompts back to WeChat.
- Modify `src/main.ts`: add `attach [project]` command.
- Modify `src/commands/router.ts`: route `/models`.
- Modify `src/commands/handlers.ts`: add model service to command context, implement `/models`, improve `/model` and `/status`.
- Modify `src/commands/helpCatalog.ts`: document `/models`.
- Modify docs: `README.md`, `docs/commands.md`, `docs/integrations.md`, `integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md`.
- Add tests: `tests/eventBus.test.ts`, `tests/modelService.test.ts`, `tests/attachProtocol.test.ts`, `tests/attachServer.test.ts`, `tests/attachClient.test.ts`, plus updates to existing command/runtime tests.

## Task 1: Event Bus And Socket Path

**Files:**
- Create: `src/core/EventBus.ts`
- Modify: `src/config/paths.ts`
- Test: `tests/eventBus.test.ts`

- [ ] **Step 1: Write failing EventBus tests**

Create `tests/eventBus.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { EventBus, type BridgeEvent } from "../src/core/EventBus.js";

test("EventBus publishes events to active subscribers", async () => {
  const bus = new EventBus();
  const received: BridgeEvent[] = [];
  const unsubscribe = bus.subscribe((event) => received.push(event));

  await bus.publish({ type: "user_message", source: "wechat", project: "bridge", text: "hi", timestamp: "2026-04-27T00:00:00.000Z" });
  unsubscribe();
  await bus.publish({ type: "user_message", source: "attach", project: "bridge", text: "ignored", timestamp: "2026-04-27T00:00:01.000Z" });

  assert.deepEqual(received.map((event) => event.type), ["user_message"]);
  assert.equal(received[0]?.source, "wechat");
  assert.equal(received[0]?.project, "bridge");
});

test("EventBus isolates subscriber failures", async () => {
  const bus = new EventBus();
  const received: BridgeEvent[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((event) => received.push(event));

  await bus.publish({ type: "state", project: "bridge", state: "idle", model: "Codex CLI default", modelSource: "unresolved", timestamp: "2026-04-27T00:00:00.000Z" });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "state");
});
```

- [ ] **Step 2: Run EventBus test to verify it fails**

Run:

```bash
npx tsx --test tests/eventBus.test.ts
```

Expected: FAIL with an import error for `src/core/EventBus.ts`.

- [ ] **Step 3: Implement EventBus**

Create `src/core/EventBus.ts`:

```ts
import type { AgentMode } from "../backend/AgentBackend.js";
import type { SessionState } from "../session/types.js";

export type BridgePromptSource = "wechat" | "attach";
export type BridgeModelSource = "project override" | "codex config" | "unresolved";

export type BridgeEvent =
  | { type: "user_message"; source: BridgePromptSource; project: string; text: string; timestamp: string }
  | { type: "turn_started"; source: BridgePromptSource; project: string; model: string; modelSource: BridgeModelSource; mode: AgentMode; timestamp: string }
  | { type: "codex_event"; project: string; text: string; timestamp: string }
  | { type: "turn_completed"; project: string; text?: string; timestamp: string }
  | { type: "turn_failed"; project: string; message: string; timestamp: string }
  | { type: "state"; project: string; state: SessionState; model: string; modelSource: BridgeModelSource; timestamp: string };

export type BridgeEventHandler = (event: BridgeEvent) => void | Promise<void>;

export interface BridgeEventBus {
  publish(event: BridgeEvent): Promise<void>;
  subscribe(handler: BridgeEventHandler): () => void;
}

export class EventBus implements BridgeEventBus {
  private readonly handlers = new Set<BridgeEventHandler>();

  subscribe(handler: BridgeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: BridgeEvent): Promise<void> {
    await Promise.allSettled([...this.handlers].map((handler) => handler(event)));
  }
}

export class NullEventBus implements BridgeEventBus {
  subscribe(): () => void {
    return () => undefined;
  }

  async publish(): Promise<void> {
    return undefined;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Add attach socket path**

Modify `src/config/paths.ts`:

```ts
export function getAttachSocketPath(): string {
  return join(getDataDir(), "bridge.sock");
}
```

- [ ] **Step 5: Run EventBus test to verify it passes**

Run:

```bash
npx tsx --test tests/eventBus.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/core/EventBus.ts src/config/paths.ts tests/eventBus.test.ts
git commit -m "feat: add bridge event bus"
```

## Task 2: Model Service

**Files:**
- Create: `src/core/ModelService.ts`
- Test: `tests/modelService.test.ts`

- [ ] **Step 1: Write failing ModelService tests**

Create `tests/modelService.test.ts`:

```ts
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
  assert.equal("base_instructions" in catalog.models[0]!, false);
});
```

- [ ] **Step 2: Run ModelService test to verify it fails**

Run:

```bash
npx tsx --test tests/modelService.test.ts
```

Expected: FAIL with an import error for `src/core/ModelService.ts`.

- [ ] **Step 3: Implement ModelService**

Create `src/core/ModelService.ts`:

```ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeModelSource } from "./EventBus.js";
import type { ProjectSession } from "../session/types.js";

const execFileAsync = promisify(execFile);
const CODEX_CLI_DEFAULT = "Codex CLI default";

export interface ModelState {
  configuredModel?: string;
  codexDefaultModel?: string;
  effectiveModel: string;
  source: BridgeModelSource;
}

export interface ModelCatalogEntry {
  slug: string;
  displayName?: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: Array<{ effort?: string; description?: string }>;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
}

export interface ModelServiceOptions {
  codexHome?: string;
  codexBin?: string;
}

export class ModelService {
  private readonly codexHome: string;
  private readonly codexBin: string;

  constructor(options: ModelServiceOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.codexBin = options.codexBin ?? "codex";
  }

  async describeSession(session: Pick<ProjectSession, "model">): Promise<ModelState> {
    const configuredModel = session.model?.trim() || undefined;
    const codexDefaultModel = await this.readCodexDefaultModel();
    if (configuredModel) {
      return { configuredModel, codexDefaultModel, effectiveModel: configuredModel, source: "project override" };
    }
    if (codexDefaultModel) {
      return { codexDefaultModel, effectiveModel: codexDefaultModel, source: "codex config" };
    }
    return { effectiveModel: CODEX_CLI_DEFAULT, source: "unresolved" };
  }

  async listModels(): Promise<ModelCatalog> {
    const { stdout } = await execFileAsync(this.codexBin, ["debug", "models"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseCodexModelCatalog(stdout);
  }

  private async readCodexDefaultModel(): Promise<string | undefined> {
    try {
      return parseCodexDefaultModel(await readFile(join(this.codexHome, "config.toml"), "utf8"));
    } catch {
      return undefined;
    }
  }
}

export function parseCodexDefaultModel(configToml: string): string | undefined {
  for (const line of configToml.split("\n")) {
    if (/^\s*\[/.test(line)) return undefined;
    const match = /^\s*model\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

export function parseCodexModelCatalog(stdout: string): ModelCatalog {
  const jsonLine = stdout.split("\n").find((line) => line.trimStart().startsWith("{"));
  if (!jsonLine) throw new Error("Codex model catalog did not contain JSON output.");
  const raw = JSON.parse(jsonLine) as { models?: unknown[] };
  const models = (raw.models ?? [])
    .map((item): ModelCatalogEntry | undefined => sanitizeModelEntry(item))
    .filter((item): item is ModelCatalogEntry => Boolean(item));
  return { models };
}

function sanitizeModelEntry(item: unknown): ModelCatalogEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  if (!slug) return undefined;
  return {
    slug,
    displayName: stringField(record.display_name),
    description: stringField(record.description),
    defaultReasoningLevel: stringField(record.default_reasoning_level),
    supportedReasoningLevels: Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels.map((level) => ({
          effort: typeof (level as { effort?: unknown }).effort === "string" ? (level as { effort: string }).effort : undefined,
          description: typeof (level as { description?: unknown }).description === "string" ? (level as { description: string }).description : undefined,
        }))
      : undefined,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
```

- [ ] **Step 4: Run ModelService test to verify it passes**

Run:

```bash
npx tsx --test tests/modelService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/core/ModelService.ts tests/modelService.test.ts
git commit -m "feat: add codex model service"
```

## Task 3: Model Commands And Status Output

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts`
- Modify: `src/commands/helpCatalog.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Add failing command tests**

Append to `tests/commands.test.ts`:

```ts
class FakeModelService {
  async describeSession(session: { model?: string }) {
    if (session.model) {
      return { configuredModel: session.model, codexDefaultModel: "gpt-default", effectiveModel: session.model, source: "project override" as const };
    }
    return { codexDefaultModel: "gpt-default", effectiveModel: "gpt-default", source: "codex config" as const };
  }

  async listModels() {
    return {
      models: [
        {
          slug: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Frontier model",
          defaultReasoningLevel: "medium",
        },
      ],
    };
  }
}

test("project-aware /model shows effective model and source", async () => {
  const projectManager = new FakeProjectManager();

  const show = await routeCommand({
    text: "/model",
    projectManager,
    boundUserId: "user-1",
    modelService: new FakeModelService(),
  });

  assert.equal(show.handled, true);
  assert.match(show.reply ?? "", /当前模型: gpt-default/);
  assert.match(show.reply ?? "", /模型来源: codex config/);
});

test("/models lists sanitized Codex model catalog", async () => {
  const projectManager = new FakeProjectManager();

  const result = await routeCommand({
    text: "/models",
    projectManager,
    boundUserId: "user-1",
    modelService: new FakeModelService(),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /gpt-5.5/);
  assert.match(result.reply ?? "", /GPT-5.5/);
  assert.match(result.reply ?? "", /medium/);
});

test("project-aware /status includes model source", async () => {
  const projectManager = new FakeProjectManager();
  await projectManager.setModel("bridge", "gpt-5.5");

  const result = await routeCommand({
    text: "/status bridge",
    projectManager,
    boundUserId: "user-1",
    modelService: new FakeModelService(),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply ?? "", /模型: gpt-5.5/);
  assert.match(result.reply ?? "", /模型来源: project override/);
});
```

- [ ] **Step 2: Run command tests to verify they fail**

Run:

```bash
npx tsx --test tests/commands.test.ts
```

Expected: FAIL because `CommandContext` does not accept `modelService`, `/models` is unknown, and status/model output lacks source lines.

- [ ] **Step 3: Add model service command types and formatters**

Modify `src/commands/handlers.ts` imports and `CommandContext`:

```ts
import { ModelService, type ModelCatalog, type ModelState } from "../core/ModelService.js";

export interface CommandContext {
  text: string;
  session?: BridgeSession;
  projectManager?: CommandProjectManager;
  modelService?: Pick<ModelService, "describeSession" | "listModels">;
  boundUserId: string;
  toUserId?: string;
  contextToken?: string;
  clearSession?: () => Promise<BridgeSession>;
  formatHistory?: (limit?: number) => string;
}

function modelServiceFrom(ctx: CommandContext): Pick<ModelService, "describeSession" | "listModels"> {
  return ctx.modelService ?? new ModelService();
}

function formatModelState(state: ModelState): string[] {
  return [`当前模型: ${state.effectiveModel}`, `模型来源: ${state.source}`];
}

function formatModelCatalog(catalog: ModelCatalog): string {
  if (catalog.models.length === 0) return "Codex 模型目录为空。";
  return [
    "可用模型:",
    ...catalog.models.map((model) => {
      const display = model.displayName ? ` (${model.displayName})` : "";
      const reasoning = model.defaultReasoningLevel ? ` | reasoning: ${model.defaultReasoningLevel}` : "";
      const description = model.description ? ` | ${model.description}` : "";
      return `- ${model.slug}${display}${reasoning}${description}`;
    }),
  ].join("\n");
}
```

- [ ] **Step 4: Implement `/models` handler**

Add in `src/commands/handlers.ts`:

```ts
export async function handleModels(ctx: CommandContext, _args = ""): Promise<CommandResult> {
  try {
    return { handled: true, reply: formatModelCatalog(await modelServiceFrom(ctx).listModels()) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: true, reply: `无法读取 Codex 模型目录: ${message}` };
  }
}
```

Modify `src/commands/router.ts` import and switch:

```ts
  handleModels,
```

```ts
      case "models":
        return await handleModels(ctx, args);
```

- [ ] **Step 5: Improve `/model` and `/status` output**

Modify `handleModel()` legacy no-args branch:

```ts
  if (!args.trim()) {
    const state = await modelServiceFrom(ctx).describeSession(session as ProjectSession);
    return { handled: true, reply: [...formatModelState(state), "用法: /model <name>"].join("\n") };
  }
```

First update the project-aware call site in `handleModel()`:

```ts
  if (ctx.projectManager) {
    return handleProjectModel(ctx, ctx.projectManager, args);
  }
```

Then update the helper signature:

```ts
async function handleProjectModel(ctx: CommandContext, manager: CommandProjectManager, args: string): Promise<CommandResult>
```

Modify `handleProjectModel()` no-args branch:

```ts
  if (!modelArg.trim()) {
    const session = await manager.session(alias);
    const state = await modelServiceFrom(ctx).describeSession(session);
    return {
      handled: true,
      reply: [`当前项目: ${alias ?? manager.activeProjectAlias}`, ...formatModelState(state), "用法: /model [project] <name>"].join("\n"),
    };
  }
```

Modify `handleProjectStatus()` and `formatProjectSessionStatus()` so they call `modelServiceFrom(ctx).describeSession(session)` and include:

```ts
`模型: ${modelState.effectiveModel}`,
`模型来源: ${modelState.source}`,
```

- [ ] **Step 6: Add `/models` help entry**

Modify `src/commands/helpCatalog.ts` by inserting after the `model` entry:

```ts
  {
    name: "models",
    summary: "查看 Codex 可用模型目录",
    syntax: ["/models"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/models"],
    notes: ["模型目录来自本机 codex debug models；读取失败不会影响 /model <name>。"],
  },
```

- [ ] **Step 7: Run command tests to verify they pass**

Run:

```bash
npx tsx --test tests/commands.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add src/commands/handlers.ts src/commands/router.ts src/commands/helpCatalog.ts tests/commands.test.ts
git commit -m "feat: expose codex model commands"
```

## Task 4: Attach Protocol And Terminal Command Parser

**Files:**
- Create: `src/ipc/protocol.ts`
- Create: `src/ipc/attachCommands.ts`
- Test: `tests/attachProtocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Create `tests/attachProtocol.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { parseAttachInput } from "../src/ipc/attachCommands.js";
import { JsonLineBuffer, serializeAttachEvent } from "../src/ipc/protocol.js";

test("JsonLineBuffer emits complete JSON lines", () => {
  const buffer = new JsonLineBuffer();
  assert.deepEqual(buffer.push('{"type":"hello"'), []);
  assert.deepEqual(buffer.push('}\n{"type":"status"}\n'), [{ type: "hello" }, { type: "status" }]);
});

test("JsonLineBuffer reports invalid JSON lines as errors", () => {
  const buffer = new JsonLineBuffer();
  assert.throws(() => buffer.push("{bad}\n"), /Invalid JSONL message/);
});

test("serializeAttachEvent writes one JSON object per line", () => {
  assert.equal(serializeAttachEvent({ type: "error", message: "boom" }), '{"type":"error","message":"boom"}\n');
});

test("parseAttachInput maps plain text and colon commands", () => {
  assert.deepEqual(parseAttachInput("fix tests", "bridge"), { type: "prompt", project: "bridge", text: "fix tests" });
  assert.deepEqual(parseAttachInput(":interrupt", "bridge"), { type: "command", project: "bridge", name: "interrupt" });
  assert.deepEqual(parseAttachInput(":replace retry this", "bridge"), { type: "command", project: "bridge", name: "replace", text: "retry this" });
  assert.deepEqual(parseAttachInput(":model gpt-5.5", "bridge"), { type: "command", project: "bridge", name: "model", value: "gpt-5.5" });
  assert.deepEqual(parseAttachInput(":models", "bridge"), { type: "command", project: "bridge", name: "models" });
  assert.deepEqual(parseAttachInput(":status", "bridge"), { type: "command", project: "bridge", name: "status" });
});
```

- [ ] **Step 2: Run protocol tests to verify they fail**

Run:

```bash
npx tsx --test tests/attachProtocol.test.ts
```

Expected: FAIL with import errors for `src/ipc/protocol.ts` and `src/ipc/attachCommands.ts`.

- [ ] **Step 3: Implement attach protocol types and JSONL helpers**

Create `src/ipc/protocol.ts`:

```ts
import type { BridgeEvent } from "../core/EventBus.js";
import type { ModelCatalogEntry } from "../core/ModelService.js";

export type AttachClientMessage =
  | { type: "hello"; client: "attach-cli"; project?: string }
  | { type: "prompt"; project?: string; text: string }
  | { type: "command"; project?: string; name: "status" | "project" | "interrupt" | "replace" | "model" | "models"; value?: string; text?: string };

export type AttachServerEvent =
  | BridgeEvent
  | { type: "ready"; activeProject: string; projects: Array<{ alias: string; cwd: string; ready: boolean; active: boolean }> }
  | { type: "models"; models: ModelCatalogEntry[] }
  | { type: "error"; message: string };

export class JsonLineBuffer {
  private pending = "";

  push(chunk: string): unknown[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim()).map((line) => parseJsonLine(line));
  }
}

export function serializeAttachEvent(event: AttachServerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function serializeAttachMessage(message: AttachClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL message: ${message}`);
  }
}
```

- [ ] **Step 4: Implement attach terminal command parser**

Create `src/ipc/attachCommands.ts`:

```ts
import type { AttachClientMessage } from "./protocol.js";

export function parseAttachInput(input: string, activeProject?: string): AttachClientMessage | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (!text.startsWith(":")) return { type: "prompt", project: activeProject, text: input };

  const [name = "", ...restParts] = text.slice(1).split(/\s+/);
  const rest = restParts.join(" ").trim();
  switch (name) {
    case "status":
      return { type: "command", project: activeProject, name: "status" };
    case "project":
      return { type: "command", name: "project", value: rest || undefined };
    case "interrupt":
      return { type: "command", project: rest || activeProject, name: "interrupt" };
    case "replace":
      return { type: "command", project: activeProject, name: "replace", text: rest };
    case "model":
      return { type: "command", project: activeProject, name: "model", value: rest || undefined };
    case "models":
      return { type: "command", project: activeProject, name: "models" };
    default:
      return { type: "command", name: "status" };
  }
}
```

- [ ] **Step 5: Run protocol tests to verify they pass**

Run:

```bash
npx tsx --test tests/attachProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add src/ipc/protocol.ts src/ipc/attachCommands.ts tests/attachProtocol.test.ts
git commit -m "feat: add attach ipc protocol"
```

## Task 5: Publish Runtime Events

**Files:**
- Modify: `src/core/ProjectRuntime.ts`
- Modify: `src/core/ProjectRuntimeManager.ts`
- Modify: `src/core/BridgeService.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/projectRuntime.test.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Add failing runtime event tests**

Append to `tests/projectRuntime.test.ts`:

```ts
test("ProjectRuntimeManager publishes user and turn events", async () => {
  const events: unknown[] = [];
  const { manager, backend } = makeManager({
    eventBus: { publish: async (event: unknown) => events.push(event), subscribe: () => () => undefined },
    modelService: { describeSession: async () => ({ effectiveModel: "gpt-5.5", source: "project override" as const }) },
  });
  backend.enqueue({ text: "done", events: [{ event: { type: "turn.started" }, formatted: "Codex 开始处理" }] });

  await manager.runPrompt({ prompt: "hi", toUserId: "user-1", contextToken: "ctx", source: "wechat" });

  assert.deepEqual(events.map((event) => (event as { type: string }).type), [
    "user_message",
    "turn_started",
    "codex_event",
    "turn_completed",
    "state",
  ]);
  assert.equal((events[0] as { source: string }).source, "wechat");
  assert.equal((events[1] as { model: string }).model, "gpt-5.5");
});
```

Update the local `makeManager()` helper in `tests/projectRuntime.test.ts` options type:

```ts
eventBus?: { publish(event: unknown): Promise<void>; subscribe(handler: (event: unknown) => void): () => void };
modelService?: { describeSession(session: ProjectSession): Promise<{ effectiveModel: string; source: "project override" | "codex config" | "unresolved" }> };
```

Pass those options into the real `ProjectRuntimeManager` constructor.

- [ ] **Step 2: Run runtime tests to verify they fail**

Run:

```bash
npx tsx --test tests/projectRuntime.test.ts
```

Expected: FAIL because `ProjectRuntimeManager` does not accept `eventBus`, `modelService`, or `source`.

- [ ] **Step 3: Add event/model dependencies to ProjectRuntimeManager**

Modify `src/core/ProjectRuntimeManager.ts`:

```ts
import { NullEventBus, nowIso, type BridgeEventBus, type BridgePromptSource } from "./EventBus.js";
import { ModelService, type ModelState } from "./ModelService.js";
```

Extend options and run options:

```ts
  eventBus?: BridgeEventBus;
  modelService?: Pick<ModelService, "describeSession">;
```

```ts
export interface ManagerRunPromptOptions {
  projectAlias?: string;
  prompt: string;
  toUserId: string;
  contextToken: string;
  source?: BridgePromptSource;
}
```

Add fields with defaults:

```ts
  private readonly eventBus: BridgeEventBus;
  private readonly modelService: Pick<ModelService, "describeSession">;
```

```ts
    this.eventBus = options.eventBus ?? new NullEventBus();
    this.modelService = options.modelService ?? new ModelService();
```

When constructing `ProjectRuntime`, pass `eventBus` and `modelService`.

In `runPrompt()` after resolving alias and before `runtime.runPrompt()`:

```ts
    await this.eventBus.publish({
      type: "user_message",
      source: options.source ?? "wechat",
      project: alias,
      text: options.prompt,
      timestamp: nowIso(),
    });
```

- [ ] **Step 4: Add event/model dependencies to ProjectRuntime**

Modify `src/core/ProjectRuntime.ts` imports and options:

```ts
import { NullEventBus, nowIso, type BridgeEventBus, type BridgePromptSource } from "./EventBus.js";
import { ModelService } from "./ModelService.js";
```

```ts
  eventBus?: BridgeEventBus;
  modelService?: Pick<ModelService, "describeSession">;
```

```ts
  source?: BridgePromptSource;
```

Add fields and defaults:

```ts
  private readonly eventBus: BridgeEventBus;
  private readonly modelService: Pick<ModelService, "describeSession">;
```

```ts
    this.eventBus = options.eventBus ?? new NullEventBus();
    this.modelService = options.modelService ?? new ModelService();
```

At the start of `runPrompt()`, after session save:

```ts
    const modelState = await this.modelService.describeSession(session);
    await this.eventBus.publish({
      type: "turn_started",
      source: options.source ?? "wechat",
      project: this.project.alias,
      model: modelState.effectiveModel,
      modelSource: modelState.source,
      mode: session.mode,
      timestamp: nowIso(),
    });
```

Inside `onEvent`, when `formatted` exists and active turn still matches:

```ts
            await this.eventBus.publish({
              type: "codex_event",
              project: this.project.alias,
              text: formatted,
              timestamp: nowIso(),
            });
```

When `result.text` is available:

```ts
        await this.eventBus.publish({ type: "turn_completed", project: this.project.alias, text: result.text, timestamp: nowIso() });
```

In the `catch` block:

```ts
      await this.eventBus.publish({ type: "turn_failed", project: this.project.alias, message, timestamp: nowIso() });
```

In `finally`, after saving idle state:

```ts
        const finalModelState = await this.modelService.describeSession(session);
        await this.eventBus.publish({
          type: "state",
          project: this.project.alias,
          state: session.state,
          model: finalModelState.effectiveModel,
          modelSource: finalModelState.source,
          timestamp: nowIso(),
        });
```

- [ ] **Step 5: Pass source from BridgeService**

Modify `src/core/BridgeService.ts` call to `runPrompt()`:

```ts
      await this.projectManager.runPrompt({
        ...(targeted ? { projectAlias: targeted.projectAlias } : {}),
        prompt: targeted?.prompt ?? rawText,
        toUserId: fromUserId,
        contextToken,
        source: "wechat",
      });
```

- [ ] **Step 6: Wire EventBus and ModelService in runtime builder**

Modify `src/runtime/bridge.ts`:

```ts
import { EventBus } from "../core/EventBus.js";
import { ModelService } from "../core/ModelService.js";
```

In `buildProjectBridgeRuntime()`:

```ts
  const eventBus = new EventBus();
  const modelService = new ModelService();
```

Pass both to `ProjectRuntimeManager`:

```ts
    eventBus,
    modelService,
```

Add them to the returned object:

```ts
  eventBus,
  modelService,
```

Update the return type accordingly.

- [ ] **Step 7: Run runtime and bridge tests**

Run:

```bash
npx tsx --test tests/projectRuntime.test.ts tests/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

Run:

```bash
git add src/core/ProjectRuntime.ts src/core/ProjectRuntimeManager.ts src/core/BridgeService.ts src/runtime/bridge.ts tests/projectRuntime.test.ts tests/bridge.test.ts
git commit -m "feat: publish bridge runtime events"
```

## Task 6: Attach Server

**Files:**
- Create: `src/ipc/AttachServer.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/attachServer.test.ts`

- [ ] **Step 1: Write failing AttachServer tests**

Create `tests/attachServer.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../src/core/EventBus.js";
import { AttachServer } from "../src/ipc/AttachServer.js";
import { JsonLineBuffer, serializeAttachMessage } from "../src/ipc/protocol.js";

class FakeProjectManager {
  activeProjectAlias = "bridge";
  prompts: Array<{ projectAlias?: string; prompt: string; source?: string }> = [];
  interrupts: Array<string | undefined> = [];
  replacements: Array<{ projectAlias?: string; prompt: string }> = [];
  models: Array<{ alias?: string; model?: string }> = [];

  async listProjects() {
    return [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }];
  }

  async runPrompt(options: { projectAlias?: string; prompt: string; source?: string }) {
    this.prompts.push(options);
  }

  async interrupt(alias?: string) {
    this.interrupts.push(alias);
  }

  async replacePrompt(options: { projectAlias?: string; prompt: string }) {
    this.replacements.push(options);
  }

  async setModel(alias: string | undefined, model: string | undefined) {
    this.models.push({ alias, model });
    return { projectAlias: alias ?? "bridge", model };
  }

  async session() {
    return { projectAlias: "bridge", state: "idle", model: "gpt-5.5", mode: "readonly", history: [], cwd: "/tmp/bridge" };
  }
}

async function readEvent(socketPath: string, write?: string): Promise<unknown> {
  const socket = connect(socketPath);
  const buffer = new JsonLineBuffer();
  return await new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      const events = buffer.push(chunk.toString("utf8"));
      if (events.length > 0) {
        socket.end();
        resolve(events[0]);
      }
    });
    socket.on("connect", () => {
      if (write) socket.write(write);
    });
  });
}

test("AttachServer sends ready and dispatches prompts", async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "wcb-attach-")), "bridge.sock");
  const eventBus = new EventBus();
  const manager = new FakeProjectManager();
  const server = new AttachServer({
    socketPath,
    eventBus,
    projectManager: manager,
    boundUserId: "user-1",
    sendWechatText: async () => undefined,
    modelService: { listModels: async () => ({ models: [] }) },
  });
  await server.start();

  const ready = await readEvent(socketPath, serializeAttachMessage({ type: "hello", client: "attach-cli", project: "bridge" }));
  assert.equal((ready as { type: string }).type, "ready");

  const socket = connect(socketPath);
  socket.write(serializeAttachMessage({ type: "prompt", project: "bridge", text: "hi" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.end();
  await server.stop();

  assert.equal(manager.prompts[0]?.prompt, "hi");
  assert.equal(manager.prompts[0]?.source, "attach");
});
```

- [ ] **Step 2: Run AttachServer test to verify it fails**

Run:

```bash
npx tsx --test tests/attachServer.test.ts
```

Expected: FAIL with an import error for `src/ipc/AttachServer.ts`.

- [ ] **Step 3: Implement AttachServer**

Create `src/ipc/AttachServer.ts`:

```ts
import { mkdir, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { dirname } from "node:path";

import type { BridgeEventBus } from "../core/EventBus.js";
import type { ModelService } from "../core/ModelService.js";
import type { ProjectRuntimeManager } from "../core/ProjectRuntimeManager.js";
import { JsonLineBuffer, serializeAttachEvent, type AttachClientMessage, type AttachServerEvent } from "./protocol.js";

export interface AttachServerOptions {
  socketPath: string;
  eventBus: BridgeEventBus;
  projectManager: Pick<ProjectRuntimeManager, "activeProjectAlias" | "listProjects" | "runPrompt" | "interrupt" | "replacePrompt" | "setModel">;
  boundUserId: string;
  sendWechatText: (text: string) => Promise<void>;
  modelService: Pick<ModelService, "listModels">;
}

export class AttachServer {
  private readonly clients = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private unsubscribe?: () => void;

  constructor(private readonly options: AttachServerOptions) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.options.socketPath, { force: true });
    this.unsubscribe = this.options.eventBus.subscribe((event) => this.broadcast(event));
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const client of this.clients) client.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.options.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    const buffer = new JsonLineBuffer();
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("data", (chunk) => {
      try {
        for (const message of buffer.push(chunk.toString("utf8"))) {
          void this.handleMessage(socket, message as AttachClientMessage);
        }
      } catch (error) {
        this.send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private async handleMessage(socket: Socket, message: AttachClientMessage): Promise<void> {
    if (message.type === "hello") {
      this.send(socket, { type: "ready", activeProject: this.options.projectManager.activeProjectAlias, projects: await this.options.projectManager.listProjects() });
      return;
    }
    if (message.type === "prompt") {
      await this.options.sendWechatText(`[${message.project ?? this.options.projectManager.activeProjectAlias}] 桌面输入:\n${message.text}`);
      await this.options.projectManager.runPrompt({
        projectAlias: message.project,
        prompt: message.text,
        toUserId: this.options.boundUserId,
        contextToken: "",
        source: "attach",
      });
      return;
    }
    if (message.type === "command") {
      await this.handleCommand(socket, message);
    }
  }

  private async handleCommand(socket: Socket, message: Extract<AttachClientMessage, { type: "command" }>): Promise<void> {
    switch (message.name) {
      case "status":
        this.send(socket, { type: "ready", activeProject: this.options.projectManager.activeProjectAlias, projects: await this.options.projectManager.listProjects() });
        return;
      case "interrupt":
        await this.options.projectManager.interrupt(message.project);
        return;
      case "replace":
        await this.options.projectManager.replacePrompt({
          projectAlias: message.project,
          prompt: message.text ?? "",
          toUserId: this.options.boundUserId,
          contextToken: "",
          source: "attach",
        });
        return;
      case "model":
        await this.options.projectManager.setModel(message.project, message.value);
        return;
      case "models":
        this.send(socket, { type: "models", models: (await this.options.modelService.listModels()).models });
        return;
      case "project":
        this.send(socket, { type: "ready", activeProject: message.value ?? this.options.projectManager.activeProjectAlias, projects: await this.options.projectManager.listProjects() });
        return;
    }
  }

  private broadcast(event: AttachServerEvent): void {
    for (const client of this.clients) this.send(client, event);
  }

  private send(socket: Socket, event: AttachServerEvent): void {
    socket.write(serializeAttachEvent(event));
  }
}
```

- [ ] **Step 4: Start AttachServer from runtime**

Modify `src/runtime/bridge.ts` imports:

```ts
import { getAttachSocketPath } from "../config/paths.js";
import { AttachServer } from "../ipc/AttachServer.js";
```

After building runtime in `runBridge()`:

```ts
  const attachServer = new AttachServer({
    socketPath: getAttachSocketPath(),
    eventBus,
    projectManager,
    boundUserId: account.boundUserId,
    sendWechatText: async (text) => sender.sendText(account.boundUserId, "", text),
    modelService,
  });
  await attachServer.start();
```

Update shutdown:

```ts
  const shutdown = async () => {
    await attachServer.stop();
    await shutdownProjectBridgeRuntime(monitor, projectManager);
  };
```

Ensure `buildProjectBridgeRuntime()` returns `eventBus` and `modelService`.

- [ ] **Step 5: Run AttachServer test to verify it passes**

Run:

```bash
npx tsx --test tests/attachServer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src/ipc/AttachServer.ts src/runtime/bridge.ts tests/attachServer.test.ts
git commit -m "feat: add attach ipc server"
```

## Task 7: Attach Client And CLI Command

**Files:**
- Create: `src/ipc/AttachClient.ts`
- Modify: `src/main.ts`
- Test: `tests/attachClient.test.ts`
- Test: `tests/projectName.test.ts`

- [ ] **Step 1: Write failing attach client tests**

Create `tests/attachClient.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { renderAttachEvent } from "../src/ipc/AttachClient.js";

test("renderAttachEvent formats ready and runtime events", () => {
  assert.match(
    renderAttachEvent({ type: "ready", activeProject: "bridge", projects: [{ alias: "bridge", cwd: "/tmp/bridge", ready: true, active: true }] }),
    /active project: bridge/,
  );
  assert.match(
    renderAttachEvent({ type: "turn_started", source: "wechat", project: "bridge", model: "gpt-5.5", modelSource: "project override", mode: "workspace", timestamp: "2026-04-27T00:00:00.000Z" }),
    /model: gpt-5.5/,
  );
  assert.match(
    renderAttachEvent({ type: "codex_event", project: "bridge", text: "命令开始: npm test", timestamp: "2026-04-27T00:00:00.000Z" }),
    /\[bridge\] 命令开始: npm test/,
  );
});
```

- [ ] **Step 2: Run attach client test to verify it fails**

Run:

```bash
npx tsx --test tests/attachClient.test.ts
```

Expected: FAIL with an import error for `src/ipc/AttachClient.ts`.

- [ ] **Step 3: Implement AttachClient renderer and runner**

Create `src/ipc/AttachClient.ts`:

```ts
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import type { Readable, Writable } from "node:stream";

import { getAttachSocketPath } from "../config/paths.js";
import { parseAttachInput } from "./attachCommands.js";
import { JsonLineBuffer, serializeAttachMessage, type AttachServerEvent } from "./protocol.js";

export interface RunAttachOptions {
  project?: string;
  socketPath?: string;
  stdin?: Readable;
  stdout?: Writable;
}

export async function runAttach(options: RunAttachOptions = {}): Promise<void> {
  const socketPath = options.socketPath ?? getAttachSocketPath();
  const output = options.stdout ?? defaultStdout;
  const socket = connect(socketPath);
  const buffer = new JsonLineBuffer();
  let activeProject = options.project;

  socket.on("connect", () => {
    socket.write(serializeAttachMessage({ type: "hello", client: "attach-cli", project: options.project }));
  });
  socket.on("data", (chunk) => {
    for (const event of buffer.push(chunk.toString("utf8")) as AttachServerEvent[]) {
      if (event.type === "ready") activeProject = event.activeProject;
      output.write(`${renderAttachEvent(event)}\n`);
    }
  });
  socket.on("error", (error) => {
    output.write(`Unable to connect to wechat-agent-bridge daemon: ${error.message}\n`);
  });

  const rl = createInterface({ input: options.stdin ?? defaultStdin });
  rl.on("line", (line) => {
    const message = parseAttachInput(line, activeProject);
    if (message) socket.write(serializeAttachMessage(message));
  });

  await new Promise<void>((resolve) => socket.on("close", () => resolve()));
}

export function renderAttachEvent(event: AttachServerEvent): string {
  switch (event.type) {
    case "ready":
      return [`connected to wechat-agent-bridge`, `active project: ${event.activeProject}`, `projects: ${event.projects.map((project) => project.alias).join(", ")}`].join("\n");
    case "user_message":
      return `[${event.project}] ${event.source}: ${event.text}`;
    case "turn_started":
      return [`[${event.project}] Codex started`, `model: ${event.model}`, `model source: ${event.modelSource}`, `mode: ${event.mode}`, `source: ${event.source}`].join("\n");
    case "codex_event":
      return `[${event.project}] ${event.text}`;
    case "turn_completed":
      return `[${event.project}] completed${event.text ? `\n${event.text}` : ""}`;
    case "turn_failed":
      return `[${event.project}] failed: ${event.message}`;
    case "state":
      return `[${event.project}] state: ${event.state} | model: ${event.model} | source: ${event.modelSource}`;
    case "models":
      return [`available models:`, ...event.models.map((model) => `- ${model.slug}${model.displayName ? ` (${model.displayName})` : ""}`)].join("\n");
    case "error":
      return `error: ${event.message}`;
  }
}
```

- [ ] **Step 4: Add `attach` subcommand**

Modify `src/main.ts`:

```ts
import { runAttach } from "./ipc/AttachClient.js";
```

Inside `main()` before the default start branch:

```ts
  if (command === "attach") {
    await runAttach({ project: subcommand });
    return;
  }
```

Update usage:

```ts
  console.log("Usage: npm run setup | npm run start | npm run mcp | npm run daemon -- start|stop|status|logs|restart | wechat-agent-bridge attach [project]");
```

- [ ] **Step 5: Ensure bin test still passes**

Run:

```bash
npx tsx --test tests/attachClient.test.ts tests/projectName.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

Run:

```bash
git add src/ipc/AttachClient.ts src/main.ts tests/attachClient.test.ts tests/projectName.test.ts
git commit -m "feat: add attach cli client"
```

## Task 8: Documentation And Help

**Files:**
- Modify: `README.md`
- Modify: `docs/commands.md`
- Modify: `docs/integrations.md`
- Modify: `integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md`

- [ ] **Step 1: Update README desktop attach section**

Modify `README.md` after the MCP Server section:

```md
## 桌面同步终端

启动 daemon 后，可以在电脑终端连接同一个 bridge runtime：

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

普通输入会作为当前项目 prompt 执行。以 `:` 开头的是本地控制命令：

```text
:status
:model
:model gpt-5.5
:models
:interrupt
:replace 重新按这个方向做
```

微信发起的任务会同步显示在 attach 终端；attach 发起的任务会同步显示到微信。两端共享同一个项目 session、mode、model 和运行中 turn。
```
```

When applying the edit, keep Markdown fences balanced. Use Chinese wording consistent with the rest of the README.

- [ ] **Step 2: Update command docs**

Modify `docs/commands.md` under `/model`:

```md
- 注意事项：不带参数时显示当前项目的有效模型和模型来源；模型来源可能是项目 override、Codex config 或 Codex CLI default。
```

Add a new section after `/model`:

```md
## /models

- 作用：查看本机 Codex 可用模型目录
- 语法：`/models`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/models`
- 注意事项：模型目录来自 `codex debug models`；读取失败不会影响 `/model <name>` 设置。
```

- [ ] **Step 3: Update integration docs and skill**

Modify `docs/integrations.md` Codex section:

```md
Desktop mirroring is exposed by the project binary:

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach <project>
```

This is a companion terminal frontend, not the official Codex TUI attaching to a bridge-managed process.
```
```

Modify `integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md` tool list:

```md
- `wechat-agent-bridge attach [project]`: open the local desktop companion terminal for mirrored bridge turns.
- `/models` and `:models`: list sanitized Codex model catalog entries when available.
```

- [ ] **Step 4: Commit Task 8**

Run:

```bash
git add README.md docs/commands.md docs/integrations.md integrations/codex/plugin/skills/wechat-agent-bridge/SKILL.md
git commit -m "docs: document attach cli and models"
```

## Task 9: Full Verification

**Files:**
- No source changes expected unless a verification failure identifies a concrete bug.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx tsx --test tests/eventBus.test.ts tests/modelService.test.ts tests/attachProtocol.test.ts tests/attachServer.test.ts tests/attachClient.test.ts tests/commands.test.ts tests/projectRuntime.test.ts tests/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Manual local smoke test**

Start the bridge in one terminal:

```bash
npm run start
```

In another terminal:

```bash
npm run build
node dist/src/main.js attach bridge
```

Expected:

- Attach prints `connected to wechat-agent-bridge`.
- `:status` prints the active project list.
- `:model` prints effective model and source.
- `:models` prints sanitized model entries or a clear catalog error.
- A plain attach prompt appears in WeChat before Codex starts.
- A WeChat prompt appears in attach before Codex starts.

- [ ] **Step 6: Final commit if verification fixes were needed**

If verification required code or doc fixes, commit them:

```bash
git add <changed-files>
git commit -m "fix: stabilize attach cli integration"
```

Expected: no commit is needed if Tasks 1-8 were correct.

## Notes For Execution

- Keep `blog.md` untouched if it remains an unrelated untracked file.
- Do not change the single-user local security boundary.
- Do not add a TCP server.
- Do not pass `codexDefaultModel` as `--model`; only `session.model` should be passed. The default model is displayed for visibility while Codex CLI remains responsible for applying its config.
- Keep attach disconnect non-destructive: closing the terminal must not interrupt the running project turn.
- If `codex debug models` returns very large fields, sanitize before display and tests should assert raw `base_instructions` is absent.
