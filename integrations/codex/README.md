# Codex Integration

This directory contains the thin Codex-side wrapper for `wechat-agent-bridge`.

Current verified local CLI surface:

- `codex mcp add <name> -- <command...>`
- `codex plugin marketplace add <source>`

The current CLI on this machine does not expose `codex plugin create`, `codex plugin install`, or `codex plugin marketplace list`, so this integration keeps the plugin material repo-local and documents the MCP registration command instead of inventing unsupported install commands.

## Register The MCP Server

From the repository root:

```bash
npm install
npm run build
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Use an absolute `--prefix` path so Codex can launch the stdio MCP server from any working directory.

## Plugin Folder

`plugin/` follows the current Codex plugin scaffold shape:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/wechat-agent-bridge/SKILL.md`

The `.mcp.json` file is a local template. The most reliable registration path today is still `codex mcp add ...` with the absolute repository path above.
