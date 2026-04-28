# wechat-agent-bridge

> 個人の WeChat プライベートチャットをローカルの coding agent daemon につなぎ、WeChat からローカル Codex を操作し、同じ bridge を MCP からも使えるようにするプロジェクトです。

Other Languages:
[中文](README.md) · [English](README_EN.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge は個人用のローカル bridge です。ひとつの绑定済み WeChat アカウントからの私聊メッセージを監視し、通常メッセージをローカル coding agent に渡し、進捗と最終結果を WeChat に返します。

現在は `projectsRoot` ベースのマルチプロジェクト session に対応しています。`wechat-agent-bridge` や `SageTalk` のようなローカル repo を同じ project root 配下に置き、それぞれ独立した Codex session、history、mode、model を保持できます。

公共 bot でもチーム共有サービスでもありません。v1 はデフォルトで Codex CLI backend を使い、绑定済みの WeChat ユーザー 1 人と、現在の OS ユーザーのローカル Codex ログイン状態だけを対象にします。

## Quick Start

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` は Codex のログイン状態を確認し、WeChat を绑定し、project root と default project を聞きます。

ブラウザ callback が使いにくい場合は、先に次を実行してください：

```bash
codex login --device-auth
```

## インストールとデプロイ

### 前提条件

- Node.js 20 以上
- npm
- ローカルに `codex` CLI がインストールされ、bridge daemon を実行する同じ OS ユーザーで `codex login` が完了していること
- 绑定に使う個人 WeChat アカウント
- ローカル project を 1 階層目の子ディレクトリとして置く `projectsRoot` ディレクトリ

### ソースからインストール

```bash
git clone https://github.com/zijian-ai-projects/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
npm run build
```

初回利用前にローカル設定と WeChat 绑定を初期化します。

```bash
npm run setup
```

`setup` は設定、アカウント、session data を `~/.wechat-agent-bridge` に書き込みます。これらのファイルにはローカル状態とアカウント情報が含まれるため、Git に commit したり他のユーザーと共有したりしないでください。

### フォアグラウンドで実行

```bash
npm run start
```

debug や一時利用に向いています。terminal を閉じると bridge も停止します。

### バックグラウンド daemon としてデプロイ

```bash
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- restart
npm run daemon -- stop
```

v1 は systemd unit、launchd plist、Windows service を自動ではインストールしません。これはユーザー単位の daemon であり、`codex login` を完了した同じ OS ユーザーで実行してください。外部 process manager や login script から起動する場合は、絶対パスを推奨します。

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run daemon -- start
```

既存デプロイの更新：

```bash
git pull
npm install
npm run build
npm run daemon -- restart
```

source checkout から desktop mirroring terminal を使う場合、package を global link していなければ build 済み entrypoint を直接実行できます。

```bash
node dist/src/main.js attach
node dist/src/main.js attach SageTalk
```

`wechat-agent-bridge attach` を直接使いたい場合は、repo 内で一度実行します。

```bash
npm link
```

## Everyday WeChat Usage

```text
/project
/project SageTalk
/model
/model gpt-5.5
/models
@SageTalk run tests and summarize failures
```

`@ProjectName` を付けない通常メッセージは、現在の project に送られます。
`/model` は現在の project で実際に使われる model とその source を表示します。`/model <name>` はその project の model を切り替え、`/models` はローカル Codex の model catalog を読み取ります。

完全なコマンド一覧は [docs/commands.md](docs/commands.md) を参照してください。

## Project Directory Rules

- `projectsRoot` 配下の 1 階層目の子ディレクトリだけを project として扱います
- 新しい repo をその中に置くと `/project` に表示されます
- Git ではないディレクトリは `/project <name> --init` で明示的に初期化する必要があります
- 起動時は前回使っていた project を優先して復元し、初回 setup では fallback の default project を選びます

## バックグラウンド daemon

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

設定、アカウント、session、runtime state、sync buffer は `0600` 権限で書き込まれます。ログは redaction され、token、cookie、Authorization header、Codex auth ファイルの内容を含めてはいけません。

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
  "projectsRoot": "/Users/you/.codex/projects",
  "defaultProject": "wechat-agent-bridge",
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

## デスクトップ同期ターミナル

daemon 起動後、同じ bridge runtime にローカル terminal から接続できます。

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

project 名付きで起動すると、最初にその project へ切り替えます。接続後も `:project <name>` で project を切り替えられます。

通常入力は現在の project への prompt として実行されます。`:` で始まる行はローカル制御コマンドです。

```text
:status
:project SageTalk
:model
:model gpt-5.5
:models
:interrupt
:replace この方向でやり直して
```

`:model` は引数なしで現在の project の model 状態を表示します。`:model <name>` は現在の project の model を切り替えます。

WeChat から開始した task は attach terminal に同期表示され、attach terminal から開始した task は WeChat に同期表示されます。両方とも同じ project session、mode、model、実行中 turn を共有します。

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
- `setup` と `start` は Codex の存在、Codex ログイン状態、設定済みの `projectsRoot` を確認します。
- `/cwd` は互換用コマンドで、設定済み project のディレクトリにだけ切り替えられます。
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

MCP server は同じ core services を再利用します。業務ロジックを重複実装せず、project や session rules も迂回しません。

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
│   ├── commands/
│   ├── config/
│   ├── core/
│   ├── ipc/
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
