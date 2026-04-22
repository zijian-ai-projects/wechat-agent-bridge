# Cursor Integration Notes

This directory is a template layer for future Cursor integration.

Cursor should connect to the same local MCP server:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

The bridge-side contract is the MCP tool set, not direct imports from `src/`:

- `wechat_status`
- `wechat_bind_status`
- `wechat_history`
- `session_clear`
- `agent_resume`
- `agent_interrupt`
- `agent_set_mode`
- `agent_set_cwd`

`CursorAgentBackend` currently exists only as a typed extension point. A runnable Cursor backend should not be added until Cursor turn execution, resume, interrupt, and credential semantics are defined and tested.
