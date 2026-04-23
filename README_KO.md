# wechat-agent-bridge

> 개인 WeChat 1:1 채팅을 로컬 coding agent daemon에 연결해 WeChat에서 로컬 Codex를 제어하고, 같은 bridge를 MCP로도 사용할 수 있게 합니다.

Other Languages:
[中文](README.md) · [English](README_EN.md) · [日本語](README_JA.md) · [Español](README_ES.md)

wechat-agent-bridge는 개인용 로컬 bridge입니다. 하나의 바인딩된 WeChat 계정에서 온 1:1 메시지를 감시하고, 일반 메시지를 로컬 coding agent에 전달한 뒤 진행 상황과 최종 결과를 WeChat으로 돌려보냅니다.

이제 명시적인 프로젝트 별칭과 멀티 프로젝트 세션도 지원합니다. `bridge`, `SageTalk` 같은 로컬 저장소를 하나의 WeChat bridge에 연결하고, 각 프로젝트별로 Codex session, history, mode, model을 따로 유지할 수 있습니다.

공개 bot도 아니고 팀 공유 서비스도 아닙니다. v1은 기본적으로 Codex CLI backend를 사용하며, 바인딩된 WeChat 사용자 한 명과 현재 OS 사용자의 로컬 Codex 로그인 상태만 대상으로 합니다.

## 예시

WeChat에서 전송:

```text
/status
```

응답 예:

```text
Status: idle
Mode: readonly
Current directory: /Users/you/projects/app
Recent session: no active task
```

일반 요청:

```text
이 repo의 테스트가 왜 실패하는지 확인하고 수정 방향을 제안해 주세요.
```

bridge는 이 메시지를 prompt로 로컬 Codex CLI에 전달합니다. Codex 진행 상황은 설정된 간격으로 WeChat에 동기화되고, 최종 답변도 같은 1:1 채팅으로 돌아옵니다.

특정 프로젝트에 한 번만 보내고 싶다면 다음처럼 보낼 수 있습니다:

```text
@SageTalk run tests and summarize failures
```

이 메시지는 `SageTalk` 프로젝트로만 라우팅되며 현재 active project는 바뀌지 않습니다.

## 설치와 실행

### 요구 사항

1. Node.js 20+.
2. 로컬 `codex` CLI 설치.
3. 현재 OS 사용자가 Codex CLI에 로그인되어 있어야 함.

권장 로그인:

```bash
codex login
```

브라우저 callback이 불편하다면:

```bash
codex login --device-auth
```

### 포그라운드 실행

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup`은 Codex CLI를 확인하고, QR 코드로 WeChat을 바인딩하며, 기본 작업 디렉터리와 allowlist repo roots를 저장합니다.

### 백그라운드 daemon

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

daemon도 사용자 단위 프로세스입니다. 기본적으로 현재 사용자의 Codex 로그인 상태를 재사용합니다. v1을 system-wide 공유 서비스로 실행하지 마십시오.

## 로컬 데이터

기본 데이터 디렉터리:

```text
~/.wechat-agent-bridge
```

`WECHAT_AGENT_BRIDGE_HOME`으로 변경할 수 있습니다. 기존 `WECHAT_CODEX_BRIDGE_HOME`도 호환 fallback으로 허용됩니다.

설정, 계정, session, sync buffer는 `0600` 권한으로 기록됩니다. 로그는 redaction되어야 하며 token, cookie, Authorization header, Codex auth 파일 내용을 포함하면 안 됩니다.

## Slash Commands

바인딩된 WeChat 1:1 채팅에서 보낼 수 있습니다:

- `/help`
- `/project [alias]`
- `/interrupt [project]`
- `/replace [project] <prompt>`
- `/clear [project]`
- `/status [project]`
- `/cwd [path]`
- `/model [project] [name]`
- `/mode [project] [readonly|workspace|yolo]`
- `/history [project] [n]`

`/clear`는 기존 Codex session/thread id를 버리고, 다음 일반 메시지가 새 대화로 시작되게 합니다. 그 외의 후속 대화는 `codex exec resume <SESSION_ID>`를 우선 사용합니다.

## 멀티 프로젝트 세션

`~/.wechat-agent-bridge/config.json`에서 프로젝트 별칭을 명시적으로 설정할 수 있습니다:

```json
{
  "defaultProject": "bridge",
  "projects": {
    "bridge": { "cwd": "/Users/you/.codex/projects/wechat-agent-bridge" },
    "SageTalk": { "cwd": "/Users/you/.codex/projects/SageTalk" }
  },
  "extraWritableRoots": [
    "/Users/you/.codex/projects"
  ],
  "streamIntervalMs": 10000
}
```

WeChat에서는:

- `/project` 로 설정된 프로젝트 목록과 현재 active project를 확인합니다.
- `/project SageTalk` 로 active project를 `SageTalk`으로 전환합니다.
- `@SageTalk 테스트 실패 원인 봐줘` 는 그 한 메시지만 `SageTalk`에 보냅니다.
- `/interrupt SageTalk` 는 `SageTalk`의 현재 작업을 중단합니다.
- `/replace SageTalk 새 계획대로 다시 구현해` 는 `SageTalk`의 현재 작업을 중단하고 새 prompt로 교체합니다.

각 프로젝트는 Codex session, history, mode, model을 독립적으로 유지합니다. 서로 다른 프로젝트는 동시에 실행할 수 있습니다. 같은 프로젝트가 이미 처리 중이면 `/interrupt` 또는 `/replace`를 명시하지 않는 한 새 메시지는 거절됩니다.

## Codex 모드

| 모드 | Codex sandbox |
| --- | --- |
| `readonly` | `--sandbox read-only --ask-for-approval never` |
| `workspace` | `--sandbox workspace-write --ask-for-approval never` |
| `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

기본값은 `readonly`입니다. `yolo`는 `/mode yolo`를 명시적으로 보낸 경우에만 활성화되며 위험 경고를 반환합니다.

`workspace` 모드에서 형제 디렉터리에 쓰기 권한을 주려면 `~/.wechat-agent-bridge/config.json`에 `extraWritableRoots`를 명시적으로 설정합니다.

```json
{
  "defaultCwd": "/Users/you/projects/wechat-agent-bridge",
  "allowlistRoots": [
    "/Users/you/projects/wechat-agent-bridge"
  ],
  "extraWritableRoots": [
    "/Users/you/projects"
  ],
  "streamIntervalMs": 10000
}
```

그다음 daemon을 재시작합니다:

```bash
npm run daemon -- restart
```

## MCP Server

이 프로젝트는 로컬 stdio MCP server도 제공합니다. Codex, Claude, Cursor 또는 다른 MCP client가 같은 core services를 안정적인 tool interface로 호출할 수 있습니다.

MCP 시작:

```bash
npm run mcp
```

외부 MCP client에서는 절대 경로를 권장합니다:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Codex CLI 예시:

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Tools:

| Tool | 목적 |
| --- | --- |
| `wechat_status` | 바인딩된 사용자와 현재 session 상태를 읽습니다. |
| `wechat_bind_status` | WeChat 계정이 바인딩되어 있는지 확인합니다. |
| `wechat_history` | 최근 로컬 bridge history를 읽습니다. |
| `session_clear` | 현재 작업을 중단하고 session/history/session id를 지웁니다. |
| `agent_resume` | 현재 로컬 backend로 prompt를 실행합니다. |
| `agent_interrupt` | 실행 중인 로컬 backend process를 중단합니다. |
| `agent_set_mode` | `readonly`, `workspace`, `yolo`를 전환합니다. |
| `agent_set_cwd` | allowlist 안의 Git repo root로 cwd를 전환합니다. |

자세한 내용은 [docs/mcp.md](docs/mcp.md)를 참고하십시오.

## 플랫폼 지원

현재는 Codex-first이지만, core는 이미 agent-ready 방향으로 분리되어 있습니다.

- Codex CLI: v1에서 유일하게 실행 가능한 backend.
- Codex MCP / plugin: `integrations/codex`에 기본 패키징 제공.
- Claude Code: `integrations/claude`에 MCP template과 skill draft 제공.
- Cursor: `integrations/cursor`에 MCP template과 rules draft 제공.

`ClaudeCodeBackend`와 `CursorAgentBackend`는 현재 typed extension points입니다. 실행, resume, interrupt, credential 의미가 명확해진 뒤에 실제 backend를 구현합니다.

## 현재 경계

- 바인딩된 WeChat 사용자 본인의 1:1 메시지만 처리합니다.
- 그룹 채팅, 모르는 사용자, 비바인딩 사용자, bot 메시지는 기본적으로 무시합니다.
- 다중 사용자 공유, 팀 협업, 공개 bot, 원격 호스팅은 하지 않습니다.
- daemon은 기본적으로 현재 로그인한 OS 사용자로 실행됩니다.
- `setup`과 `start`는 Codex 존재 여부, Codex 로그인 상태, 기본 cwd, allowlist roots를 확인합니다.
- `/cwd`는 allowlist 안의 Git repo root로만 전환할 수 있습니다.
- `--skip-git-repo-check`는 기본적으로 활성화하지 않습니다.

이것들은 v1의 안전 기본값이며 임시 누락이 아닙니다.

## 작동 방식

```text
WeChat 1:1 메시지
  ↓
WeChatMonitor가 메시지 수집
  ↓
BridgeService가 사용자를 필터링하고 slash command 또는 일반 prompt 처리
  ↓
AgentService가 현재 AgentBackend 호출
  ↓
CodexExecBackend가 codex exec / codex exec resume 실행
  ↓
StreamBuffer가 설정 간격으로 진행 상황 동기화
  ↓
WeChatSender가 결과 반환
```

MCP server는 같은 core services를 재사용합니다. 비즈니스 로직을 중복 구현하지 않고 allowlist나 session rules를 우회하지도 않습니다.

## 저장소 구조

```text
.
├── README.md
├── README_EN.md
├── README_JA.md
├── README_KO.md
├── README_ES.md
├── docs/
├── integrations/
├── src/
│   ├── backend/
│   ├── core/
│   ├── mcp/
│   ├── runtime/
│   ├── setup/
│   └── wechat/
└── tests/
```

## Design Notes

- [docs/design-process.md](docs/design-process.md): 설계 변화 기록.
- [docs/architecture.md](docs/architecture.md): 현재 architecture boundary.
- [docs/mcp.md](docs/mcp.md): MCP server와 tool contract.
- [docs/integrations.md](docs/integrations.md): Codex / Claude / Cursor integration strategy.

## 개발과 검증

```bash
npm run typecheck
npm test
npm run build
```

## 아키텍처 참고

이 프로젝트는 `wechat-claude-code`의 WeChat protocol, session, daemon, chunking, monitor 구조를 참고하되 Claude/Anthropic provider를 교체했습니다.

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
