# Multi-Project Codex Sessions Design

## Goal

`wechat-agent-bridge` should support independent Codex conversations for multiple local Git repositories. A user should be able to keep one WeChat chat with the bridge, route prompts to different configured projects, run tasks in different projects at the same time, and preserve each project's Codex session, history, mode, and model separately.

The first target use case is switching between:

- `bridge`: `/Users/lixinyao/.codex/projects/wechat-agent-bridge`
- `SageTalk`: `/Users/lixinyao/.codex/projects/SageTalk`

## Non-Goals

- No public bot or multi-user sharing.
- No automatic scanning of every directory under `~/.codex/projects`.
- No task queue for a busy project.
- No cross-project shared Codex session.
- No remote execution or hosted daemon behavior.

## Recommended Approach

Implement a project-aware runtime layer instead of extending the current single-session `BridgeService` directly.

Core units:

- `ProjectRegistry`: loads and validates configured project aliases and repo roots.
- `ProjectSessionStore`: stores session state per `boundUserId + projectAlias`.
- `ProjectRuntime`: owns one project's active Codex turn, interrupt behavior, replace behavior, output policy, and session persistence.
- `BridgeService`: keeps WeChat filtering and top-level routing, then delegates project work to the project runtime layer.

This keeps multi-project concurrency and per-project state isolated instead of growing the current single-session model into one large service.

## Configuration

Add explicit project aliases to `config.json`:

```json
{
  "defaultProject": "bridge",
  "projects": {
    "bridge": {
      "cwd": "/Users/lixinyao/.codex/projects/wechat-agent-bridge"
    },
    "SageTalk": {
      "cwd": "/Users/lixinyao/.codex/projects/SageTalk"
    }
  },
  "extraWritableRoots": [],
  "streamIntervalMs": 10000
}
```

Validation rules:

- `defaultProject` must exist in `projects`.
- Project aliases must use only letters, numbers, `_`, and `-`.
- Each `cwd` must exist.
- Each `cwd` must resolve to a Git repo root.
- Realpaths must be unique across projects.
- `~` should not be required in persisted config; setup and docs should write absolute realpaths.

Compatibility:

- Existing `defaultCwd` and `allowlistRoots` remain readable.
- If `projects` is missing, startup can derive project entries from old config.
- `/cwd` remains as a compatibility command, but `/project` becomes the preferred user-facing workflow.

## Project Session Model

Each project has independent state:

```text
alias
cwd
mode
model
codexSessionId
codexThreadId
history
state: idle | processing
activeTurnId
updatedAt
```

Session files should be separated by user and project, for example:

```text
sessions/
  <boundUserId>/
    bridge.json
    SageTalk.json
```

Mode and model are per-project. Changing `/mode workspace` while `SageTalk` is active should not change the mode for `bridge`.

On daemon startup, any session found in `processing` is reset to `idle`, with `activeTurnId` cleared and history preserved.

## Message Routing

Supported routing forms:

```text
/project
/project SageTalk
@SageTalk 帮我看一下测试失败
普通消息
```

Rules:

- `/project` lists projects, their status, cwd, and the active project.
- `/project SageTalk` switches the active project.
- `@SageTalk <prompt>` routes only that prompt to `SageTalk` and does not change the active project.
- Ordinary non-command messages route to the current active project.
- If a project alias is unknown, the reply includes the valid project list.

`/cwd` compatibility:

- `/cwd` shows the active project's cwd and the configured project list.
- `/cwd <path>` switches to the project whose cwd realpath matches the path.
- If no project matches, it rejects the request instead of adding a new allowed path dynamically.

## Commands

New commands:

```text
/interrupt [project]
/replace [project] <prompt>
```

Behavior:

- `/interrupt` without a project interrupts the active project.
- `/interrupt SageTalk` interrupts `SageTalk`.
- `/replace SageTalk <prompt>` interrupts `SageTalk`, waits for the old turn to stop, then starts a new turn with `<prompt>`.
- `/replace <prompt>` without a project targets the active project.
- If interrupt fails, replace does not start the new turn.

Existing commands become project-aware:

```text
/status [project]
/history [project] [n]
/mode [project] [readonly|workspace|yolo]
/model [project] [name]
/clear [project]
```

Without a project argument, commands target the active project. `/status` without a project may return a global overview, while `/status SageTalk` returns details for one project.

## Concurrency

Different projects may run at the same time. The same project may run only one task at a time.

If a prompt is routed to a project whose state is `processing`:

- Ordinary message: reject and explain that the project is busy.
- `@Project <prompt>`: reject with the same busy message.
- `/replace Project <prompt>`: interrupt the old task and start the replacement prompt.
- `/interrupt Project`: stop the old task only.

There is no per-project task queue in the first version. This avoids stale queued prompts and keeps WeChat interaction predictable.

## Output Policy

Use the selected mixed output policy:

- Active project: full streamed progress and final result.
- Background projects: only key lifecycle updates and final result summary.
- Background messages always include a project label, for example `[SageTalk]`.

If a background project becomes active while it is still running, future output from that point may use active-project streaming. Previously suppressed intermediate output is not replayed.

Key lifecycle events for background projects:

- turn started
- turn completed
- turn failed
- interrupt acknowledged
- final assistant result

## Codex Backend Behavior

Each project runtime calls Codex with its own cwd:

```text
codex --cd <project.cwd> exec ...
codex --cd <project.cwd> exec resume <project.codexSessionId> ...
```

`extraWritableRoots` remains a global config for now and is only passed in `workspace` mode as `--add-dir`. It does not grant project selection. Project selection is controlled by explicit `projects`.

If `codex exec resume` returns no useful text or session id, the existing fallback behavior applies for that project only: start a fresh Codex turn and update that project's session state.

## MCP Compatibility

MCP tools should gain optional `project` arguments while remaining backward compatible:

```text
agent_resume { project?: string, prompt: string }
agent_interrupt { project?: string }
agent_set_mode { project?: string, mode: string }
agent_set_cwd { cwd: string }
wechat_status { project?: string }
wechat_history { project?: string, limit?: number }
session_clear { project?: string }
```

When `project` is omitted, tools use the active project. A clearer `agent_set_project` tool can be added, while `agent_set_cwd` remains for compatibility and maps matching cwd paths to configured projects.

## Error Handling

Expected failures should return clear WeChat messages:

- Unknown project: show available aliases.
- Busy project: tell the user to use `/interrupt <project>` or `/replace <project> <prompt>`.
- Invalid config: fail startup with the alias and cwd that failed validation.
- Duplicate project realpath: fail startup with both aliases.
- Interrupt failure during replace: report failure and do not start the replacement prompt.
- Stale processing state after daemon restart: reset to idle and keep history.

## Tests

Add focused tests for:

- Config loading for new `projects` format.
- Compatibility with old `defaultCwd` and `allowlistRoots`.
- Alias validation and Git repo root validation.
- `/project` listing and switching.
- `@Project` routing without changing active project.
- Ordinary prompt routing to active project.
- Per-project mode, model, history, and Codex session isolation.
- Different projects running concurrently.
- Same-project busy rejection.
- `/interrupt` and `/replace` semantics.
- Active vs background output policy.
- Stale processing reset per project.
- MCP optional `project` arguments.

## Rollout

Implement in stages:

1. Add project config parsing and validation.
2. Add per-project session storage.
3. Add project-aware routing and commands.
4. Add per-project runtime concurrency and busy rejection.
5. Add output policy for active and background projects.
6. Extend MCP tools with optional project arguments.
7. Update README and setup guidance.

The first implementation should support `bridge` and `SageTalk` from explicit config and should avoid any automatic directory scanning.
