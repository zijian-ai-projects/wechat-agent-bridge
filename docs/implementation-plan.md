# Authentication And Safety Hardening Implementation Plan

## Goal

Merge the new v1 boundary, authentication, cwd/Git, JSONL, interrupt and documentation constraints into the existing MVP.

## V1 Must Do

- Enforce personal-only product boundary in docs and tests.
- Keep `msg.from_user_id === boundUserId` as a hard filter and test condition.
- Add Codex CLI authentication self-checks using `codex login status`.
- Prefer current terminal user's ChatGPT Codex login cache; API key is only an optional Codex CLI fallback.
- Validate default cwd and `/cwd` targets as normalized real paths inside allowlisted Git repo roots.
- Avoid `--skip-git-repo-check` by default.
- Parse only stdout JSONL from `codex exec --json`; treat stderr as logs/errors only.
- Support known Codex event summaries and ignore unknown event types safely.
- Interrupt old turns with `SIGINT`, then `SIGKILL` after timeout, before starting the new ordinary message.
- Protect against late old-turn events with active turn tokens.
- Update README with prerequisites, login priority, daemon credential assumptions, and auth troubleshooting.

## V2 Only

- `codex app-server` deep integration.
- WeChat-side approval workflows.
- Fine-grained turn pause/resume beyond process cancellation.
- Multi-user, team collaboration, shared public bot, tenant isolation.

## File Tree After This Update

```text
src/
  backend/
    AgentBackend.ts
    CodexExecBackend.ts
    CodexAppServerBackend.ts
    codexEvents.ts
  commands/
    handlers.ts
    router.ts
  config/
    accounts.ts
    codexAuth.ts
    config.ts
    git.ts
    paths.ts
    secureStore.ts
    security.ts
  daemon/
    manager.ts
  logging/
    logger.ts
    redact.ts
  runtime/
    bridge.ts
    chunking.ts
    codexAvailability.ts
    preflight.ts
    streamBuffer.ts
  session/
    sessionStore.ts
    types.ts
  setup/
    setup.ts
  wechat/
    api.ts
    login.ts
    message.ts
    monitor.ts
    sender.ts
    syncBuffer.ts
    types.ts
tests/
  auth.test.ts
  bridge.test.ts
  chunking.test.ts
  codexBackend.test.ts
  commands.test.ts
  cwdGit.test.ts
  logger.test.ts
  security.test.ts
  sessionStore.test.ts
```

## Task Plan

1. Add tests for Codex login status parsing, not-logged-in guidance, and sensitive auth redaction.
2. Add tests for cwd/Git validation and `/cwd` failure messages.
3. Add tests for JSONL stdout/stderr separation, unknown event handling, `/clear` session reset, and SIGINT-first interrupt behavior.
4. Implement `config/codexAuth.ts`, `config/git.ts`, and `runtime/preflight.ts`.
5. Wire preflight into `setup` and `start`.
6. Extend session/config types with allowlisted repo roots and optional explicit skip-Git exceptions.
7. Update command routing to validate `/cwd` as an allowlisted repo root.
8. Update `CodexExecBackend` interrupt and event handling.
9. Update runtime bridge with active turn tokens to discard late old-turn output.
10. Update README and v2 docs.
11. Run `npm test`, `npm run typecheck`, and `npm run build`.
