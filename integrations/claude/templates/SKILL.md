---
name: wechat-agent-bridge
description: Draft Claude-side skill instructions for using the wechat-agent-bridge MCP tools.
---

# WeChat Agent Bridge

Use the configured MCP server instead of shelling into bridge internals.

## Tool Mapping

- `wechat_status`: inspect bridge state.
- `wechat_bind_status`: confirm setup/binding.
- `wechat_history`: read recent conversation history.
- `session_clear`: clear local session and discard the old Codex session id.
- `agent_resume`: send a prompt through the active local backend.
- `agent_interrupt`: interrupt active work.
- `agent_set_mode`: change sandbox mode.
- `agent_set_cwd`: change cwd within allowlist roots.

## Boundaries

This bridge is single-user and local. Do not ask it to serve group chats, strangers, or multiple OS users. Do not bypass MCP tools by constructing shell commands from WeChat text.
