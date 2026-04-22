# Claude Integration Notes

This directory is intentionally a template layer, not a finished Claude installable package.

The shared integration point is the local MCP server started by:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Map Claude-side MCP usage to these bridge tools:

- status checks: `wechat_status`, `wechat_bind_status`
- history: `wechat_history`
- session lifecycle: `session_clear`, `agent_interrupt`, `agent_resume`
- local state: `agent_set_mode`, `agent_set_cwd`

Do not implement a Claude backend until there is a concrete execution contract for Claude Code turns, resume semantics, interrupt behavior, and local credential reuse. Until then Claude should consume the same MCP tools rather than bypassing the core services.
