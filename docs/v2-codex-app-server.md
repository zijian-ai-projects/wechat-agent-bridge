# v2: Codex App Server Backend

The MVP uses `codex exec --json` because it is stable and simple: each turn is one child process, and interrupt maps to killing that process.

To support WeChat-native approvals and finer turn control, v2 should implement `CodexAppServerBackend` against `codex app-server`.

## Upgrade Plan

1. Start `codex app-server --listen ws://127.0.0.1:<port>` as a managed child process or connect to an existing local app-server.
2. Generate protocol bindings with `codex app-server generate-ts` and keep them in `src/backend/appServerProtocol/`.
3. Map `AgentBackend.startTurn` and `resumeTurn` to app-server conversation/turn requests instead of `codex exec`.
4. Map app-server tool approval events into WeChat prompts, for example: send a summary plus `回复 /approve <id>` or `/deny <id>`.
5. Add an approval store keyed by bound user and app-server approval id, with timeout and crash recovery.
6. Replace process-level `interrupt` with app-server turn cancellation.
7. Preserve the same `AgentBackend` output formatting so WeChat, command routing, session store and stream buffering remain unchanged.

## Benefits

- Approval can happen inside WeChat instead of being disabled with `--ask-for-approval never`.
- Turns can be paused, resumed, cancelled and inspected with finer granularity.
- File changes and command execution metadata can be rendered more accurately than best-effort JSONL summaries.
