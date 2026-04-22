# WeChat Agent Bridge Cursor Template

Use this note as a future Cursor rule or command-mapping seed.

## Preferred Interface

Use the `wechat-agent-bridge` MCP server. Do not import bridge internals or execute WeChat text as shell.

## Commands

- Inspect: `wechat_status`, `wechat_bind_status`
- History: `wechat_history`
- Control: `session_clear`, `agent_interrupt`, `agent_resume`
- State: `agent_set_mode`, `agent_set_cwd`

## Safety

Preserve v1 semantics: personal bound user only, private chat only, readonly by default, explicit yolo, and cwd restricted to allowlisted Git repo roots.
