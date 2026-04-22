# Core + MCP + Thin Adapters Implementation Plan

## Goal

Keep the existing v1 WeChat-to-agent daemon runnable with Codex as the default backend while evolving the repository into core services, backend adapters, a local MCP surface, and platform integration templates.

## Module Mapping

| Current module | Target module | Action |
|---|---|---|
| `runtime/bridge.ts` | `core/BridgeService.ts` | Move message filtering, command routing, interrupt-before-new-message, and turn state handling into core. |
| `runtime/bridge.ts` | `runtime/bridge.ts` | Keep daemon assembly, preflight, account/session loading, WeChat monitor setup, and shutdown. |
| `session/sessionStore.ts` | `core/SessionService.ts` | Wrap persistence with status/history/clear methods shared by daemon and MCP. |
| `commands/*` | `core/ModeService.ts` | Keep slash commands, but expose mode/cwd/model state changes for MCP. |
| `backend/AgentBackend.ts` | `backend/capabilities.ts` | Add backend capability metadata. Codex is runnable; Claude/Cursor are placeholders. |
| none | `mcp/server.ts`, `mcp/tools/*` | Expose core service operations as stdio MCP tools. |
| none | `integrations/*` | Add Codex plugin scaffold and Claude/Cursor templates. |

## Phase A: Extract Core Without Behavior Change

- Add core tests for message filtering, interrupt semantics, `/clear`, resume fallback, cwd allowlist, and session status/history.
- Implement `AgentService`, `BridgeService`, `SessionService`, `ModeService`, `WechatService`, and shared error/types files.
- Keep `handleMessageForTest` as a compatibility wrapper.
- Verify with `npm test` and `npm run typecheck`.

## Phase B: Add MCP

- Install official MCP TypeScript SDK.
- Implement `src/mcp/server.ts` with stdio transport.
- Add `src/mcp-main.ts`.
- Add `npm run mcp`.
- Expose:
  - `wechat_status`
  - `wechat_bind_status`
  - `wechat_history`
  - `session_clear`
  - `agent_resume`
  - `agent_interrupt`
  - `agent_set_mode`
  - `agent_set_cwd`
- Verify with MCP tool tests, typecheck, and build.

## Phase C: Codex Integration

- Verify local Codex CLI command surface before writing install instructions.
- Add `integrations/codex/plugin/.codex-plugin/plugin.json`.
- Add `integrations/codex/plugin/.mcp.json` as a local template.
- Add Codex skill instructions mapping MCP tools to bridge actions.
- Document `codex mcp add wechat-agent-bridge -- npm --prefix ... run mcp`.

## Phase D: Claude/Cursor Templates

- Add MCP config templates and mapping docs.
- Do not implement runnable Claude/Cursor backends in this phase.
- Keep `ClaudeCodeBackend` and `CursorAgentBackend` as typed extension points only.

## Verification Gates

After each phase:

```bash
npm test
npm run typecheck
```

Before final handoff:

```bash
npm test
npm run typecheck
npm run build
```

## Follow-Up Roadmap

- Add real MCP client smoke tests using framed stdio requests.
- Add a validated Codex marketplace root once distribution is decided.
- Promote Claude/Cursor templates to installable packages only after confirming their current package formats.
- Implement `ClaudeCodeBackend` or `CursorAgentBackend` only after their execution/resume/interrupt semantics are documented and covered by tests.
