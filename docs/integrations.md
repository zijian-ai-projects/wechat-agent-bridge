# Integrations

The project now has a thin-adapter integration strategy:

1. Keep core behavior in `src/core`.
2. Expose the core through `src/mcp`.
3. Put platform-specific packaging, templates, and docs under `integrations/`.

This avoids forcing Codex, Claude, and Cursor into one fake universal plugin format.

## Codex

Status: most complete.

Files:

```text
integrations/codex/
  README.md
  plugin/
    .codex-plugin/plugin.json
    .mcp.json
    skills/wechat-agent-bridge/SKILL.md
```

Current verified Codex CLI commands:

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
codex plugin marketplace add <source>
```

The local CLI does not currently expose `codex plugin create`, `codex plugin install`, or `codex plugin marketplace list`, so the integration is a plugin scaffold plus MCP registration instructions.

## Claude

Status: template and mapping only.

Files:

```text
integrations/claude/
  docs/README.md
  templates/mcp.local.json
  templates/SKILL.md
```

Claude should connect to the same stdio MCP server. A native `ClaudeCodeBackend` is intentionally not runnable until turn execution, resume, interrupt, and credential semantics are defined and tested.

## Cursor

Status: template and mapping only.

Files:

```text
integrations/cursor/
  docs/README.md
  templates/mcp.json
  templates/wechat-agent-bridge.md
```

Cursor should use `.cursor/mcp.json` or user-level MCP settings to launch the same `npm --prefix ... run mcp` command.

## Tool Mapping

| Capability | MCP Tool |
|---|---|
| Runtime status | `wechat_status` |
| Binding status | `wechat_bind_status` |
| History | `wechat_history` |
| Clear session | `session_clear` |
| Resume/start agent turn | `agent_resume` |
| Interrupt agent | `agent_interrupt` |
| Set mode | `agent_set_mode` |
| Set cwd | `agent_set_cwd` |

## Next Steps

- Add a validated Codex marketplace root once the desired distribution path is known.
- Convert Claude templates into an installable package only after confirming the target Claude Code plugin/package format.
- Convert Cursor templates into a checked-in `.cursor/mcp.json` or project command only after deciding whether this repo should own project-level Cursor config.
- Implement `ClaudeCodeBackend` or `CursorAgentBackend` only after a concrete backend execution contract exists.
