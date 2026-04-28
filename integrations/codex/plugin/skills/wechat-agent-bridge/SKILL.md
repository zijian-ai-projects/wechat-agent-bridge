---
name: wechat-agent-bridge
description: Use the local wechat-agent-bridge MCP tools to inspect and control the personal WeChat-to-agent bridge daemon.
---

# WeChat Agent Bridge

Use this skill when the user asks about their local WeChat bridge state, wants to inspect bridge history, or wants to control the local agent session through MCP.

## Available MCP Tools

- `wechat_status`: current bound WeChat user and session state.
- `wechat_bind_status`: whether setup has bound a WeChat account.
- `wechat_history`: recent bridge conversation history.
- `session_clear`: interrupt and clear the current local session.
- `agent_resume`: run a prompt through the configured local agent backend.
- `agent_interrupt`: interrupt the active local agent turn.
- `agent_set_mode`: set `readonly`, `workspace`, or `yolo`.
- `agent_set_cwd`: set the agent cwd to an allowlisted Git repo root.
- `wechat-agent-bridge attach [project]`: open the local desktop companion terminal for mirrored bridge turns.
- `/models` and `:models`: list sanitized Codex model catalog entries when available.

## Safety

Keep the v1 boundary intact:

- Only the bound personal WeChat user is served.
- Group chats, strangers, bot messages, and non-bound users are ignored.
- `yolo` must be explicitly selected.
- `agent_set_cwd` only accepts allowlisted Git repo roots.
- Text from WeChat is passed as an agent prompt and is never executed as shell by the bridge.
