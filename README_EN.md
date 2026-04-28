# wechat-agent-bridge

> Connect a personal WeChat private chat to a local coding-agent daemon, so you can control local Codex from WeChat and expose the same bridge through MCP.

Other Languages:
[中文](README.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge is a personal local bridge. It listens to private messages from one bound WeChat account, sends ordinary messages to a local coding agent, and returns progress and final results back to WeChat.

It now supports `projectsRoot`-based multi-project sessions. You can place local repos such as `wechat-agent-bridge` and `SageTalk` under one shared project root and keep separate Codex sessions, history, mode, and model state for each one.

It is not a public bot or a team service. v1 uses the Codex CLI backend by default and serves only one bound WeChat user plus the current operating-system user's local Codex login state.

## Quick Start

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` checks Codex login, binds WeChat, and asks for the project root plus the default project.

If browser callback is inconvenient, run this first:

```bash
codex login --device-auth
```

## Installation and Deployment

### Prerequisites

- Node.js 20 or newer
- npm
- The `codex` CLI installed locally, with `codex login` completed by the same OS user that will run the bridge daemon
- A personal WeChat account to bind
- A `projectsRoot` directory with local projects as first-level child directories

On Windows, if PowerShell can run `codex` but `npm run setup` still says the Codex CLI cannot be found, first update to the latest code with Windows shim resolution. If it still fails, set the Codex executable explicitly:

```powershell
codex --version
Get-Command codex
$env:WECHAT_AGENT_BRIDGE_CODEX_BIN = (Get-Command codex).Source
npm run setup
```

### Install from Source

```bash
git clone https://github.com/zijian-ai-projects/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
npm run build
```

Initialize local config and WeChat binding before first use:

```bash
npm run setup
```

`setup` writes config, account, and session data under `~/.wechat-agent-bridge`. These files contain local state and account data. Do not commit them to Git or share them with other users.

### Run in the Foreground

```bash
npm run start
```

This is best for debugging or temporary use. The bridge stops when the terminal exits. After startup succeeds, it opens a desktop mirroring terminal that runs `npm run attach`. If your OS blocks the popup or no new window appears, run it manually:

```bash
npm run attach
```

### Deploy as a Background Daemon

```bash
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- restart
npm run daemon -- stop
```

v1 does not install a systemd unit, launchd plist, or Windows service automatically. It is a user-level daemon and should run as the same OS user that completed `codex login`. If you start it from an external process manager or login script, prefer an absolute path:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run daemon -- start
```

Update an existing deployment:

```bash
git pull
npm install
npm run build
npm run daemon -- restart
```

When running from a source checkout, prefer the npm script for the desktop mirroring terminal:

```bash
npm run attach
npm run attach -- SageTalk
```

To use `wechat-agent-bridge attach` directly, run once from the repo:

```bash
npm link
```

## Everyday WeChat Usage

```text
/project
/project SageTalk
/model
/model gpt-5.5
/models
@SageTalk run tests and summarize failures
```

Ordinary messages without `@ProjectName` go to the current project.
`/model` shows the effective model and its source for the current project; `/model <name>` switches that project's model; `/models` reads the local Codex model catalog.

See [docs/commands.md](docs/commands.md) for the full command reference.

## Project Directory Rules

- Only first-level child directories under `projectsRoot` are treated as projects
- Drop a new repo into that directory and it appears in `/project`
- A non-Git directory must be initialized explicitly with `/project <name> --init`
- On startup the bridge restores the last active project when possible; first-time setup chooses the fallback default

## Background Daemon

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

The daemon is still a user-level process. It reuses the current user's Codex login state by default. Do not run v1 as a system-wide shared service.

## Local Data

Default data directory:

```text
~/.wechat-agent-bridge
```

Set `WECHAT_AGENT_BRIDGE_HOME` to override it. The old `WECHAT_CODEX_BRIDGE_HOME` variable is still accepted as a compatibility fallback.

Config, account data, sessions, runtime state, and sync buffers are written with `0600` permissions. Logs are redacted and must not contain tokens, cookies, Authorization headers, or Codex auth file contents.

## Codex Modes

| Mode | Codex sandbox |
| --- | --- |
| `readonly` | `--sandbox read-only --ask-for-approval never` |
| `workspace` | `--sandbox workspace-write --ask-for-approval never` |
| `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

The default is `readonly`. `yolo` is enabled only after an explicit `/mode yolo` command and returns a danger warning.

To let `workspace` mode write to sibling directories, configure `extraWritableRoots` in `~/.wechat-agent-bridge/config.json`:

```json
{
  "projectsRoot": "/Users/you/.codex/projects",
  "defaultProject": "wechat-agent-bridge",
  "extraWritableRoots": [
    "/Users/you/projects"
  ],
  "streamIntervalMs": 10000
}
```

Then restart the daemon:

```bash
npm run daemon -- restart
```

## MCP Server

The project also provides a local stdio MCP server. Codex, Claude, Cursor, or another MCP client can call the same core services through a stable tool interface.

Start MCP:

```bash
npm run mcp
```

For external MCP clients, use an absolute path:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Codex CLI example:

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Tools:

| Tool | Purpose |
| --- | --- |
| `wechat_status` | Read bound user and current session status. |
| `wechat_bind_status` | Check whether a WeChat account is bound. |
| `wechat_history` | Read recent local bridge history. |
| `session_clear` | Interrupt current work and clear session/history/session id. |
| `agent_resume` | Run a prompt through the current local backend. |
| `agent_interrupt` | Interrupt the active local backend process. |
| `agent_set_mode` | Switch between `readonly`, `workspace`, and `yolo`. |
| `agent_set_cwd` | Switch cwd to an allowlisted Git repo root. |

See [docs/mcp.md](docs/mcp.md).

## Desktop Mirroring Terminal

`npm run start` opens one desktop mirroring terminal automatically after the foreground daemon starts. The background daemon does not open popups; attach manually when needed:

```bash
npm run attach
npm run attach -- SageTalk
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

Starting with a project name switches to that project first. After connecting, use `:project <name>` to switch projects.

Plain input is sent as a prompt for the current project. Lines beginning with `:` are local control commands:

```text
:status
:project SageTalk
:model
:model gpt-5.5
:models
:interrupt
:replace redo it in this direction
```

`:model` without arguments shows the current project model state; `:model <name>` switches the current project model.

Tasks started from WeChat appear in the attached terminal, and tasks started from the terminal appear in WeChat. Both sides share the same project session, mode, model, and active turn.

## Platform Support

The project is Codex-first today, but its core is already structured to be agent-ready:

- Codex CLI: the only runnable v1 backend.
- Codex MCP / plugin: base packaging under `integrations/codex`.
- Claude Code: MCP template and skill draft under `integrations/claude`.
- Cursor: MCP template and rules draft under `integrations/cursor`.

`ClaudeCodeBackend` and `CursorAgentBackend` are currently typed extension points. Real backends should only be implemented after execution, resume, interrupt, and credential semantics are clear.

## Current Boundaries

- Handles only private messages from the bound WeChat user.
- Ignores group chats, strangers, non-bound users, and bot messages by default.
- No multi-user sharing, team collaboration, public bot, or remote hosting.
- The daemon runs as the current logged-in OS user by default.
- `setup` and `start` check Codex availability, Codex login state, and the configured `projectsRoot`.
- `/cwd` is a compatibility command and can switch only to configured project directories.
- `--skip-git-repo-check` is not enabled by default.

These are v1 safety defaults, not temporary omissions.

## How It Works

```text
WeChat private message
  ↓
WeChatMonitor fetches messages
  ↓
BridgeService filters the user and handles slash commands or ordinary prompts
  ↓
AgentService calls the current AgentBackend
  ↓
CodexExecBackend runs codex exec / codex exec resume
  ↓
StreamBuffer syncs progress at a configured interval
  ↓
WeChatSender returns the result
```

The MCP server reuses the same core services. It does not duplicate business logic and does not bypass project or session rules.

## Repository Structure

```text
.
├── README.md
├── README_EN.md
├── README_JA.md
├── README_KO.md
├── README_ES.md
├── docs/
├── integrations/
├── src/
│   ├── backend/
│   ├── commands/
│   ├── config/
│   ├── core/
│   ├── ipc/
│   ├── mcp/
│   ├── runtime/
│   ├── setup/
│   └── wechat/
└── tests/
```

## Design Notes

- [docs/design-process.md](docs/design-process.md): design evolution notes.
- [docs/architecture.md](docs/architecture.md): current architecture boundaries.
- [docs/mcp.md](docs/mcp.md): MCP server and tool contract.
- [docs/integrations.md](docs/integrations.md): Codex / Claude / Cursor integration strategy.

## Development and Verification

```bash
npm run typecheck
npm test
npm run build
```

## Architecture References

This project borrows WeChat protocol, session, daemon, chunking, and monitor structure from `wechat-claude-code`, while replacing the Claude/Anthropic provider:

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
