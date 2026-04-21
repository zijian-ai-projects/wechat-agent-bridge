# Architecture

`wechat-codex-bridge` is a personal bridge between one bound WeChat account and the local Codex CLI daemon running as the same OS user. It is not a multi-tenant service, not a shared team bot, and not a public bot.

## Reference Architecture Breakdown

The reference project `wechat-claude-code` is useful for architecture boundaries, not provider code. We keep these ideas:

- WeChat protocol is isolated under `src/wechat/*`: QR login, long polling, sync buffer, message sending and protocol types.
- Runtime orchestration is separate from protocol code: monitor receives messages, runtime filters and routes them, backend executes agent turns.
- Session state is persisted locally and recovered to `idle` after a daemon crash.
- Slash commands are routed before ordinary agent turns.
- Long WeChat replies are split, and streaming progress is buffered to avoid flooding the user.
- Daemon management is user-level, with foreground and background entry points.
- Logs are redacted and rotated.

We replace these parts:

- No Claude/Anthropic SDK provider, permission broker, or Claude-specific skill adapter.
- Agent execution goes through `AgentBackend`; v1 uses `CodexExecBackend`.
- Codex turns use `codex exec --json` and `codex exec resume --json`.
- Future skill support remains an extension point, but v1 is a daemon product, not a Codex skill.

## V1 Product Boundary

V1 is deliberately single-user:

- One personal WeChat bot/account is bound during `setup`.
- The daemon only processes direct private messages where `msg.from_user_id === boundUserId`.
- Group chats, bot messages, and messages from any non-bound user are ignored by default.
- `msg.from_user_id === boundUserId` is a hard acceptance condition and must be covered by tests.
- V1 does not implement multi-user sharing, team collaboration, public bot behavior, ACLs, or tenant separation.

## Authentication Model

V1 must reuse the current terminal user's Codex CLI login by default.

Priority:

1. Existing ChatGPT login state from Codex CLI credential store.
2. Existing Codex API key login state from Codex CLI credential store.
3. Optional API key fallback only if the user explicitly configured Codex that way.

The project must not be API-key-only and must not require `OPENAI_API_KEY` to use the default path. `setup` and `start` both run `codex login status` and distinguish:

- `Logged in using ChatGPT`
- API key login
- not logged in

If not logged in, the error must tell the user to run `codex login`, or `codex login --device-auth` if browser callback is inconvenient. The daemon is assumed to run as the same OS user that completed `codex login`; if a background environment cannot access the login state or keyring, it must fail with a clear message rather than silently falling back to API key mode.

Codex credential-store compatibility:

- `cli_auth_credentials_store = auto | keyring | file` remains Codex CLI's responsibility.
- `auto` and `keyring` should be reused directly via `codex login status` and `codex exec`.
- If keyring access fails in the background daemon, the user is told to run as the same login user or switch Codex to file credential storage.
- File mode reads only `CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`, for validation/permission checks. The bridge never logs auth content, access tokens, refresh tokens, or authorization headers.

## Setup And Start Self-Checks

`setup` and `start` must fail loudly with actionable errors when checks fail.

Required checks:

1. `codex` exists.
2. `codex login status` succeeds and reports ChatGPT or API-key login.
3. Default cwd exists and is accessible.
4. Default cwd normalizes via `realpath`.
5. Default cwd is within configured allowlist roots.
6. Default cwd is a Git repo root or inside a Git repo.
7. `/cwd` targets are allowlisted repo roots unless explicitly configured to skip the Git check.

`codex exec` defaults to requiring a Git repo. V1 does not pass `--skip-git-repo-check` by default. A future explicit per-root `skipGitRepoCheck` config may allow exceptions, but the default setup flow configures a repo root.

## Runtime Flow

1. `setup` checks Codex login, obtains a WeChat QR login, saves bot token/account/bound user id, and writes default repo root plus allowlist roots.
2. `start` checks Codex login again, validates cwd/allowlist/Git repo state, loads account/session, resets stale `processing` state to `idle`, and starts `WeChatMonitor`.
3. `WeChatMonitor` long polls with the saved sync buffer and dispatches messages without blocking the polling loop.
4. `runtime/bridge.ts` filters messages to the bound private user, routes slash commands, or sends ordinary text to `AgentBackend`.
5. `CodexExecBackend` spawns `codex exec --json` or `codex exec resume --json`.
6. Stdout is parsed only as JSONL. Stderr is never parsed as JSONL; it is captured for redacted logs and error output.
7. `StreamBuffer` aggregates formatted progress and sends chunked WeChat messages through `WeChatSender`.
8. `extraWritableRoots` are passed to Codex as `--add-dir` in `workspace` mode so explicitly configured sibling directories can be written without enabling `yolo`.

## Backend Boundary

`AgentBackend` exposes:

- `startTurn(...)`
- `resumeTurn(...)`
- `interrupt(...)`
- `formatEventForWechat(...)`

The v1 implementation is `CodexExecBackend`. `CodexAppServerBackend` is intentionally a stub so v2 can replace process-level turns with app-server turn control without changing WeChat/session/command layers.

## Codex Event Handling

V1 supports at least:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.*`
- `error`

Supported item summaries:

- `agent_message`
- reasoning summary
- `command_execution`
- `file_change`
- plan update

Unknown event types must not crash the daemon. They are logged as warnings and ignored unless they contain extractable assistant text.

## Interrupt And Concurrency Semantics

When a new ordinary message arrives while a turn is processing:

1. Create a new local turn token.
2. Soft interrupt the old Codex process with `SIGINT`.
3. If it does not exit before timeout, hard kill it with `SIGKILL`.
4. Clear old processing state.
5. Start the new turn.

`/clear` interrupts any running process, discards old session/thread ids, clears history, and starts the next ordinary message as a new Codex session. Non-`/clear` continuation uses `codex exec resume <SESSION_ID>` first.

Continuous WeChat messages can arrive concurrently. Runtime state uses a per-user active turn token so late events or final output from an old process cannot be appended to the new turn/session.

## Persistence

Local data lives under `~/.wechat-codex-bridge` unless `WECHAT_CODEX_BRIDGE_HOME` is set.

- `accounts/*.json`: bot token, account id, bound user id.
- `config.json`: default cwd, allowlist repo roots, extra writable roots, stream interval, optional explicit Git-check exceptions.
- `sessions/*.json`: one bound user's Codex session id, cwd, mode, model, history, active state.
- `sync-buffer.txt`: WeChat long-poll cursor.
- `logs/*.log`: redacted daemon logs.

Sensitive JSON files are written with mode `0600`.

## V2 Scope

V2 may implement `CodexAppServerBackend` using `codex app-server` for WeChat-side approvals and finer turn control. V2 is also the right place for team/multi-user semantics if ever needed. Those capabilities are explicitly outside v1.
