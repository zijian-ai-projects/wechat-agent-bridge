# Bidirectional Attach CLI And Model Visibility Design

## Goal

`wechat-agent-bridge` should support a low-cost desktop companion terminal that mirrors the same project turn as WeChat. When the user starts work from WeChat, the desktop terminal should show the prompt, Codex progress, command events, and final result. When the user starts work from the desktop terminal, WeChat should show the same prompt, progress, command events, and final result.

The feature should also make model state explicit. The user should be able to see the current project model, see the model used for each turn, list available Codex models when possible, and switch models from either WeChat or the desktop terminal.

## Non-Goals

- Do not make the official `codex` TUI attach to a bridge-managed Codex process.
- Do not run two Codex turns for one user prompt.
- Do not add remote networking or team access.
- Do not replay a full historical stream to a client that connects after the turn has already started.
- Do not hard-code a model allowlist in the bridge.
- Do not replace the existing WeChat command interface.

## Recommended Approach

Add a project-owned `attach` CLI instead of relying on the official Codex CLI as the desktop frontend:

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

The daemon remains the only executor. WeChat and `attach` are both frontends connected to `ProjectRuntimeManager`. This keeps session state, busy semantics, interrupt, replace, mode, model, and history in one place.

```text
wechat-agent-bridge daemon/start
  -> WeChat frontend
  -> Attach IPC server
  -> ProjectRuntimeManager
  -> ProjectRuntime per project
  -> CodexExecBackend
  -> Event broadcast back to WeChat and attach clients
```

This is the lowest-risk implementation because it reuses the existing daemon runtime and avoids depending on unverified Codex app-server attach semantics.

## User Experience

When the daemon is running, the user can attach from a desktop terminal:

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach bridge
```

The attach CLI prints current state first:

```text
connected to wechat-agent-bridge
active project: bridge
state: idle
mode: workspace
model: gpt-5.5
model source: project override
```

Plain input is treated as a project prompt. Local attach commands use a `:` prefix:

```text
:status
:project SageTalk
:model
:model gpt-5.5
:models
:interrupt
:replace rewrite this using the smaller design
```

WeChat keeps the existing slash commands:

```text
/status
/project SageTalk
/model
/model gpt-5.5
/models
/interrupt
/replace rewrite this using the smaller design
```

If WeChat sends a prompt, attach clients see the user message and all following project events. If attach sends a prompt, WeChat receives the user message and all following project events. The source is visible in synchronized displays so the user can tell where the prompt came from.

## Architecture

Add three small runtime units:

- `src/core/EventBus.ts`: in-process event bus for project/user/turn events.
- `src/ipc/AttachServer.ts`: local daemon-side IPC server that accepts attach clients, validates local-only access, parses JSONL, and sends JSONL events.
- `src/ipc/AttachClient.ts`: terminal client that connects to the daemon socket, reads stdin, sends client messages, and renders daemon events.

Add model support as a core service:

- `src/core/ModelService.ts`: resolves configured project model, best-effort Codex default model, available model catalog, model source labels, and turn model display.

Wire points:

- `src/main.ts` adds `attach [project]`.
- `src/runtime/bridge.ts` starts `AttachServer` when the bridge starts in foreground or daemon mode.
- `src/core/BridgeService.ts` publishes accepted WeChat prompts before routing them.
- `src/core/ProjectRuntime.ts` publishes turn lifecycle and formatted Codex events.
- `src/commands/handlers.ts` adds `/models` and improves `/model` and `/status` model output.

The package already exposes `wechat-agent-bridge` as a bin, so `attach` should be a new subcommand on the existing binary.

## IPC Transport

Use a Unix domain socket under the bridge home directory:

```text
~/.wechat-agent-bridge/bridge.sock
```

The bridge home directory already stores local private state. The socket is local-only and should not listen on TCP. Startup should handle a stale socket file by attempting a connection first. If the connection fails, remove the stale socket and bind again.

IPC messages use newline-delimited JSON. This keeps the protocol simple, stream-friendly, and testable with plain fixtures.

Client to daemon:

```json
{ "type": "hello", "client": "attach-cli", "project": "SageTalk" }
{ "type": "prompt", "project": "SageTalk", "text": "帮我修复测试" }
{ "type": "command", "project": "SageTalk", "name": "interrupt" }
{ "type": "command", "project": "SageTalk", "name": "replace", "text": "重新按这个方向做..." }
{ "type": "command", "project": "SageTalk", "name": "model", "value": "gpt-5.5" }
{ "type": "command", "project": "SageTalk", "name": "models" }
{ "type": "command", "name": "status" }
```

Daemon to client:

```json
{ "type": "ready", "activeProject": "bridge", "projects": [] }
{ "type": "user_message", "source": "wechat", "project": "bridge", "text": "..." }
{ "type": "turn_started", "project": "bridge", "model": "gpt-5.5", "modelSource": "project override", "mode": "workspace" }
{ "type": "codex_event", "project": "bridge", "text": "命令开始: npm test" }
{ "type": "turn_completed", "project": "bridge", "text": "..." }
{ "type": "state", "project": "bridge", "state": "idle", "model": "gpt-5.5" }
{ "type": "error", "message": "..." }
```

The first protocol version can be implicit. If incompatible changes become likely, add a `version` field to `hello` and `ready`.

## Event Flow

WeChat prompt flow:

```text
WeChat message
  -> BridgeService accepts bound direct user message
  -> EventBus publishes user_message(source=wechat)
  -> ProjectRuntimeManager.runPrompt()
  -> ProjectRuntime publishes turn_started with effective model and mode
  -> CodexExecBackend emits JSONL events
  -> ProjectRuntime publishes formatted codex_event entries
  -> WeChatSender and AttachServer both receive displayable events
```

Attach prompt flow:

```text
Attach stdin
  -> AttachClient sends prompt
  -> AttachServer validates project and command
  -> EventBus publishes user_message(source=attach)
  -> ProjectRuntimeManager.runPrompt()
  -> the same runtime event flow fans out to WeChat and attach clients
```

The same-project busy rule remains unchanged: a plain prompt to a busy project is rejected. The user must use `/replace`, `:replace`, `/interrupt`, or `:interrupt`.

## Model Visibility

Model state has three explicit concepts:

- `configuredModel`: the project session override set by `/model` or `:model`.
- `codexDefaultModel`: best-effort value read from the local Codex config.
- `effectiveModel`: the model the bridge intends to use for a turn, computed as `configuredModel ?? codexDefaultModel ?? "Codex CLI default"`.

`CodexExecBackend` already passes `session.model` to `codex exec --model <MODEL>`. The new design makes the value visible and adds default-model discovery.

Display examples:

```text
项目: bridge
状态: idle
模式: workspace
模型: gpt-5.5
模型来源: project override
```

If the bridge cannot resolve a default model:

```text
项目: bridge
状态: idle
模式: readonly
模型: Codex CLI default
模型来源: unresolved
```

Turn start events should always include the chosen display model and source:

```text
[bridge] Codex 开始处理
model: gpt-5.5
model source: project override
mode: workspace
source: wechat
```

## Model Catalog

`/models` and `:models` should call `codex debug models` and parse the JSON object from stdout. The command may print warnings before JSON, so parsing should ignore non-JSON leading lines and parse the first line that starts with `{`.

Only safe catalog fields should be exposed:

- `slug`
- `display_name`
- `description`
- `default_reasoning_level`
- `supported_reasoning_levels`
- `availability` or equivalent high-level availability fields if present

The bridge must not forward large internal prompt fields, base instructions, tokens, or auth-adjacent data from the raw catalog.

Model setting should not require the catalog to succeed. If the requested model matches a known `slug`, report it as known. If the catalog is unavailable or the model is not listed, still store the value and let Codex CLI validate it when a turn starts.

## Codex Default Model Resolution

`ModelService` should resolve the default model conservatively:

1. If the project session has `model`, use it as `configuredModel`.
2. Read `CODEX_HOME/config.toml` or `~/.codex/config.toml`.
3. Parse a top-level `model = "..."` entry as `codexDefaultModel`.
4. If parsing fails or no model is configured, return unresolved and display `Codex CLI default`.

This is intentionally best-effort. Codex profiles, CLI flags, provider selection, and future config semantics can affect the actual model. The bridge should not claim certainty when it only has a local config inference.

## Commands

Existing `/model` behavior remains project-aware:

```text
/model
/model gpt-5.5
/model SageTalk
/model SageTalk gpt-5.5
```

New `/models` behavior:

```text
/models
/models SageTalk
```

Attach command equivalents:

```text
:model
:model gpt-5.5
:model SageTalk
:model SageTalk gpt-5.5
:models
:models SageTalk
```

`/status` and `:status` should include model, model source, mode, state, active project, Codex session id, and history count.

## Error Handling

- Daemon is not running: `attach` prints a clear message explaining how to start foreground or background bridge.
- Socket file is stale: daemon removes it only after a failed connection attempt proves no server is listening.
- Client sends invalid JSON: daemon responds with an error event and keeps the connection open.
- Client requests an unknown project: daemon returns the valid project list.
- Project is not initialized: daemon returns the existing project-init guidance.
- Project is busy: daemon rejects plain prompts and points to `:interrupt` or `:replace <prompt>`.
- Attach disconnects: daemon drops the client without interrupting the running turn.
- WeChat send fails: log the redacted error and keep attach clients connected.
- Model catalog fails: show an explicit `/models` error while keeping `/model <name>` usable.
- Codex default model cannot be inferred: display `Codex CLI default` and continue.
- Codex rejects a model during a turn: surface the Codex error to both WeChat and attach clients.

## Security

The feature keeps the v1 personal-local boundary:

- The socket is local-only.
- The daemon still serves one bound WeChat account.
- The attach CLI runs as the same OS user and uses the same bridge home.
- No TCP listener is added.
- No multi-user ACLs or team sharing are added.
- Logs and errors continue to use existing redaction rules.
- Raw `codex debug models` output is filtered before display or logging.

## Persistence And Replay

Per-project sessions remain in `ProjectSessionStore`. The attach feature does not add a second session store.

The first version does not persist a full event stream. When an attach client connects, it receives:

- active project
- project list
- current project state
- recent history summary from the existing session store
- future events from the point of connection

This keeps implementation small. Full event replay can be added later with a bounded per-project event log if needed.

## Tests

Add focused tests for:

- JSONL parsing and serialization for attach IPC messages.
- `AttachServer` accepts clients and sends `ready`.
- `AttachServer` broadcasts project events to multiple clients.
- WeChat prompts publish `user_message(source=wechat)`.
- Attach prompts publish `user_message(source=attach)` and call `ProjectRuntimeManager.runPrompt`.
- Attach `:interrupt`, `:replace`, `:model`, `:models`, and `:status` map to core behavior.
- `/models` returns sanitized model catalog data.
- `/model` and `/status` show model source and effective model.
- `ModelService` resolves top-level Codex config model.
- `ModelService` handles missing config and malformed catalog output.
- Same-project busy rejection remains unchanged.
- Attach disconnect does not interrupt a project turn.

## Rollout

Implement in stages:

1. Add `EventBus` and publish project/user/turn events without changing user behavior.
2. Add `ModelService`, `/models`, and improved `/model` and `/status` output.
3. Add `AttachServer` and socket lifecycle management in the daemon.
4. Add `AttachClient` and `wechat-agent-bridge attach [project]`.
5. Route attach prompts and commands through `ProjectRuntimeManager`.
6. Update README, `docs/commands.md`, and Codex integration docs.

The first shipped version should prioritize correct local mirroring, model visibility, and predictable interruption semantics over terminal UI polish.
