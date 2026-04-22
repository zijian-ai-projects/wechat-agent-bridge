# wechat-agent-bridge

> 個人の WeChat プライベートチャットをローカルの coding agent daemon につなぎ、WeChat からローカル Codex を操作し、同じ bridge を MCP からも使えるようにするプロジェクトです。

Other Languages:
[中文](README.md) · [English](README_EN.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge は個人用のローカル bridge です。ひとつの绑定済み WeChat アカウントからの私聊メッセージを監視し、通常メッセージをローカル coding agent に渡し、進捗と最終結果を WeChat に返します。

公共 bot でもチーム共有サービスでもありません。v1 はデフォルトで Codex CLI backend を使い、绑定済みの WeChat ユーザー 1 人と、現在の OS ユーザーのローカル Codex ログイン状態だけを対象にします。

## 例

WeChat で送信：

```text
/status
```

返答例：

```text
Status: idle
Mode: readonly
Current directory: /Users/you/projects/app
Recent session: no active task
```

通常の依頼：

```text
この repo のテストが失敗している理由を調べて、修正案を出してください。
```

bridge はこのメッセージを prompt としてローカル Codex CLI に渡します。Codex の進捗は設定された間隔で WeChat に同期され、最終回答も同じ私聊に返ります。

## インストールと起動

### 前提

1. Node.js 20+。
2. ローカルに `codex` CLI がインストールされていること。
3. 現在の OS ユーザーで Codex CLI にログイン済みであること。

推奨：

```bash
codex login
```

ブラウザの callback が使いにくい場合：

```bash
codex login --device-auth
```

### フォアグラウンド起動

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` は Codex CLI を確認し、QR コードで WeChat を绑定し、デフォルト作業ディレクトリと allowlist repo roots を保存します。

### バックグラウンド daemon

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

daemon もユーザー単位のプロセスです。デフォルトでは現在のユーザーの Codex ログイン状態を再利用します。v1 を system-wide な共有サービスとして実行しないでください。

## ローカルデータ

デフォルトのデータディレクトリ：

```text
~/.wechat-agent-bridge
```

`WECHAT_AGENT_BRIDGE_HOME` で変更できます。古い `WECHAT_CODEX_BRIDGE_HOME` も互換 fallback として受け付けます。

設定、アカウント、session、sync buffer は `0600` 権限で書き込まれます。ログは redaction され、token、cookie、Authorization header、Codex auth ファイルの内容を含めてはいけません。

## Slash Commands

绑定済み WeChat 私聊で送信できます：

- `/help`
- `/clear`
- `/status`
- `/cwd [path]`
- `/model [name]`
- `/mode [readonly|workspace|yolo]`
- `/history [n]`

`/clear` は古い Codex session/thread id を破棄し、次の通常メッセージを新しい会話として開始します。それ以外の続きの会話では `codex exec resume <SESSION_ID>` を優先します。

## Codex モード

| モード | Codex sandbox |
| --- | --- |
| `readonly` | `--sandbox read-only --ask-for-approval never` |
| `workspace` | `--sandbox workspace-write --ask-for-approval never` |
| `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

デフォルトは `readonly` です。`yolo` は `/mode yolo` を明示的に送信した場合だけ有効になり、危険性の警告を返します。

`workspace` モードで兄弟ディレクトリに書き込みたい場合は、`~/.wechat-agent-bridge/config.json` に `extraWritableRoots` を明示的に設定します。

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

その後 daemon を再起動します：

```bash
npm run daemon -- restart
```

## MCP Server

このプロジェクトはローカル stdio MCP server も提供します。Codex、Claude、Cursor、または他の MCP client は同じ core services を安定した tool interface から呼び出せます。

起動：

```bash
npm run mcp
```

外部 MCP client では絶対パスを推奨します：

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Codex CLI の例：

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Tools:

| Tool | 目的 |
| --- | --- |
| `wechat_status` | 绑定ユーザーと現在の session 状態を読む。 |
| `wechat_bind_status` | WeChat アカウントが绑定済みか確認する。 |
| `wechat_history` | 直近のローカル bridge history を読む。 |
| `session_clear` | 現在の作業を中断し、session/history/session id を消す。 |
| `agent_resume` | 現在のローカル backend で prompt を実行する。 |
| `agent_interrupt` | 実行中のローカル backend process を中断する。 |
| `agent_set_mode` | `readonly`、`workspace`、`yolo` を切り替える。 |
| `agent_set_cwd` | allowlist 内の Git repo root に cwd を切り替える。 |

詳しくは [docs/mcp.md](docs/mcp.md) を参照してください。

## プラットフォーム対応

現在は Codex-first ですが、core は agent-ready な方向で分割されています。

- Codex CLI: v1 で唯一実行可能な backend。
- Codex MCP / plugin: `integrations/codex` に基本パッケージがあります。
- Claude Code: `integrations/claude` に MCP template と skill draft があります。
- Cursor: `integrations/cursor` に MCP template と rules draft があります。

`ClaudeCodeBackend` と `CursorAgentBackend` は現時点では typed extension points です。実行、resume、interrupt、credential の意味が明確になってから real backend を実装します。

## 現在の境界

- 绑定済み WeChat ユーザー本人の私聊だけを処理します。
- 群聊、知らないユーザー、非绑定ユーザー、bot メッセージはデフォルトで無視します。
- マルチユーザー共有、チーム協作、公共 bot、リモートホスティングはしません。
- daemon はデフォルトで現在ログイン中の OS ユーザーとして動きます。
- `setup` と `start` は Codex の存在、Codex ログイン状態、デフォルト cwd、allowlist roots を確認します。
- `/cwd` は allowlist 内の Git repo root にだけ切り替えられます。
- `--skip-git-repo-check` はデフォルトでは有効にしません。

これらは v1 の安全なデフォルトであり、一時的な欠落ではありません。

## 仕組み

```text
WeChat 私聊メッセージ
  ↓
WeChatMonitor がメッセージを取得
  ↓
BridgeService がユーザーをフィルタし、slash command または通常 prompt を処理
  ↓
AgentService が現在の AgentBackend を呼び出す
  ↓
CodexExecBackend が codex exec / codex exec resume を実行
  ↓
StreamBuffer が設定間隔で進捗を同期
  ↓
WeChatSender が結果を返す
```

MCP server は同じ core services を再利用します。業務ロジックを重複実装せず、allowlist や session rules も迂回しません。

## リポジトリ構成

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

- [docs/design-process.md](docs/design-process.md): 設計の変遷記録。
- [docs/architecture.md](docs/architecture.md): 現在の architecture boundary。
- [docs/mcp.md](docs/mcp.md): MCP server と tool contract。
- [docs/integrations.md](docs/integrations.md): Codex / Claude / Cursor integration strategy。

## 開発と検証

```bash
npm run typecheck
npm test
npm run build
```

## 参考アーキテクチャ

このプロジェクトは `wechat-claude-code` の WeChat protocol、session、daemon、chunking、monitor の分割を参考にしつつ、Claude/Anthropic provider を置き換えています。

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
