# MCP Server

`wechat-agent-bridge` exposes a local stdio MCP server so Codex, Claude, Cursor, or another MCP client can control the same core services without reimplementing WeChat/session/agent logic.

## Start

```bash
npm install
npm run build
npm run mcp
```

For MCP clients, prefer an absolute project path:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

The server uses stdio. It must not write normal logs to stdout because stdout is reserved for MCP JSON-RPC frames. Fatal startup errors are written to stderr and redacted file logs.

## Tools

Every tool returns a stable JSON envelope:

```json
{ "ok": true, "data": {} }
```

or:

```json
{ "ok": false, "error": { "code": "INVALID_ARGUMENT", "message": "..." } }
```

Available tools:

| Tool | Input | Purpose |
|---|---|---|
| `wechat_status` | `{}` | Bound user and current session state. |
| `wechat_bind_status` | `{}` | Whether setup has bound a WeChat account. |
| `wechat_history` | `{ "limit": 20 }` | Recent local bridge history. |
| `session_clear` | `{}` | Interrupt current agent work and clear session/history/session id. |
| `agent_resume` | `{ "prompt": "..." }` | Run a prompt through the current local backend. |
| `agent_interrupt` | `{}` | Interrupt the active local backend process. |
| `agent_set_mode` | `{ "mode": "readonly|workspace|yolo" }` | Change the current sandbox mode. |
| `agent_set_cwd` | `{ "cwd": "/repo/root" }` | Change cwd to an allowlisted Git repo root. |

## Core Contract

MCP tools call `src/core` services directly:

- `SessionService` for status/history/clear.
- `ModeService` for mode/model/cwd changes.
- `AgentService` for start/resume/interrupt.
- `WechatService` for bind/runtime status.

They do not duplicate command handler behavior and do not bypass allowlist or authentication checks.

## Client Examples

Codex CLI:

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Claude Code:

```bash
claude mcp add --transport stdio wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Cursor:

Create `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "wechat-agent-bridge": {
      "type": "stdio",
      "command": "npm",
      "args": ["--prefix", "/ABSOLUTE/PATH/TO/wechat-agent-bridge", "run", "mcp"],
      "env": {}
    }
  }
}
```

## References Checked

- MCP server build guide: https://modelcontextprotocol.io/docs/develop/build-server
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- Cursor MCP docs: https://docs.cursor.com/en/context/mcp
- Local Codex CLI help: `codex mcp add --help`, `codex plugin marketplace add --help`
