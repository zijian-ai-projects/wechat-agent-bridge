# wechat-agent-bridge

> Connect a personal WeChat private chat to a local coding-agent daemon, so you can control local Codex from WeChat and expose the same bridge through MCP.

Other Languages:
[中文](README.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge is a personal local bridge. It listens to private messages from one bound WeChat account, sends ordinary messages to a local coding agent, and returns progress and final results back to WeChat.

It is not a public bot or a team service. v1 uses the Codex CLI backend by default and serves only one bound WeChat user plus the current operating-system user's local Codex login state.

## Example

In WeChat:

```text
/status
```

Possible reply:

```text
Status: idle
Mode: readonly
Current directory: /Users/you/projects/app
Recent session: no active task
```

Send an ordinary request:

```text
Check why the tests in this repo are failing and suggest a fix.
```

The bridge sends the message as a prompt to the local Codex CLI. Codex progress is synced back to WeChat at the configured interval, and the final answer returns to the same private chat.

## Install and Run

### Requirements

1. Node.js 20+.
2. Local `codex` CLI installed.
3. The current OS user is logged in to Codex CLI.

Recommended login:

```bash
codex login
```

If browser callback is inconvenient:

```bash
codex login --device-auth
```

### Foreground

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` checks Codex CLI, binds WeChat by QR code, and saves the default working directory plus allowlisted repo roots.

### Background Daemon

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

Config, account data, sessions, and sync buffers are written with `0600` permissions. Logs are redacted and must not contain tokens, cookies, Authorization headers, or Codex auth file contents.

## Slash Commands

Send these in the bound WeChat private chat:

- `/help`
- `/clear`
- `/status`
- `/cwd [path]`
- `/model [name]`
- `/mode [readonly|workspace|yolo]`
- `/history [n]`

`/clear` discards the old Codex session or thread id, so the next ordinary message starts a fresh conversation. Otherwise, follow-up messages prefer `codex exec resume <SESSION_ID>`.

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
  "defaultCwd": "/Users/you/projects/wechat-agent-bridge",
  "allowlistRoots": [
    "/Users/you/projects/wechat-agent-bridge"
  ],
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
- `setup` and `start` check Codex availability, Codex login state, default cwd, and allowlist roots.
- `/cwd` can switch only to allowlisted Git repo roots.
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

The MCP server reuses the same core services. It does not duplicate business logic and does not bypass allowlist or session rules.

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
│   ├── core/
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
