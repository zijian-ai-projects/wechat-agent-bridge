# wechat-agent-bridge

> 把个人微信私聊连接到本机 coding agent daemon，让你可以从微信控制本机 Codex，并通过 MCP 接入其他 agent 客户端。

其他语言 / Other Languages:
[English](README_EN.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge 是一个个人本地桥接器：它监听一个绑定微信号的私聊消息，把普通消息交给本机 coding agent 执行，并把进度和结果回传到微信。

它不是公共 bot，也不是团队共享服务。v1 默认使用 Codex CLI 后端，只服务一个绑定微信号和当前系统用户的本机 Codex 登录态。

## 效果示例

微信里发送：

```text
/status
```

可能返回：

```text
状态：idle
模式：readonly
当前目录：/Users/you/projects/app
最近会话：无进行中的任务
```

微信里发送普通需求：

```text
帮我看一下这个 repo 的测试为什么失败，并给出修复建议。
```

bridge 会把这条消息作为 prompt 传给本机 Codex CLI。Codex 的进度会按节流间隔同步到微信，最终结果会回到同一个私聊窗口。

## 安装与启动

### 前提

1. Node.js 20+。
2. 已安装本机 `codex` CLI。
3. 当前系统用户已经登录 Codex CLI。

推荐先在终端完成：

```bash
codex login
```

如果浏览器回调不方便：

```bash
codex login --device-auth
```

### 前台运行

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` 会检查 Codex CLI、扫码绑定微信，并保存默认工作目录和 allowlist repo roots。

### 后台运行

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

后台 daemon 也是用户级进程，默认复用当前用户的 Codex 登录态。不要把 v1 当成 system 级共享服务运行。

## 本地数据

默认数据目录：

```text
~/.wechat-agent-bridge
```

可以用 `WECHAT_AGENT_BRIDGE_HOME` 指定目录。旧的 `WECHAT_CODEX_BRIDGE_HOME` 仍作为兼容 fallback 被接受。

配置、账号、session 和 sync buffer 会以 `0600` 写入。日志会脱敏，不能包含 token、cookie、Authorization header 或 Codex auth 文件内容。

## Slash Commands

微信私聊里可以发送：

- `/help`
- `/clear`
- `/status`
- `/cwd [path]`
- `/model [name]`
- `/mode [readonly|workspace|yolo]`
- `/history [n]`

`/clear` 会丢弃旧 Codex session/thread id，下次普通消息开启全新会话。非 `/clear` 的继续对话优先使用 `codex exec resume <SESSION_ID>`。

## Codex 模式

| 模式 | Codex sandbox |
| --- | --- |
| `readonly` | `--sandbox read-only --ask-for-approval never` |
| `workspace` | `--sandbox workspace-write --ask-for-approval never` |
| `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

默认是 `readonly`。只有显式发送 `/mode yolo` 后才启用 yolo，并会返回危险警告。

如果要让 `workspace` 模式写入兄弟目录，例如：

```text
/Users/you/projects/another-repo
```

需要在 `~/.wechat-agent-bridge/config.json` 里显式配置 `extraWritableRoots`：

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

然后重启 daemon：

```bash
npm run daemon -- restart
```

## MCP Server

项目同时提供本地 stdio MCP server。Codex、Claude、Cursor 或其他 MCP client 可以通过同一组工具调用 bridge 的 core services。

启动 MCP server：

```bash
npm run mcp
```

给外部 MCP client 使用时，推荐绝对路径：

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Codex CLI 注册示例：

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

可用工具：

| Tool | 用途 |
| --- | --- |
| `wechat_status` | 查看绑定用户和当前 session 状态。 |
| `wechat_bind_status` | 查看是否已绑定微信账号。 |
| `wechat_history` | 读取最近本地 bridge history。 |
| `session_clear` | 中断当前任务并清空 session/history/session id。 |
| `agent_resume` | 通过当前本地后端运行 prompt。 |
| `agent_interrupt` | 中断当前本地后端进程。 |
| `agent_set_mode` | 切换 `readonly`、`workspace` 或 `yolo`。 |
| `agent_set_cwd` | 切换到 allowlist 中的 Git repo root。 |

详见 [docs/mcp.md](docs/mcp.md)。

## 平台支持

当前是 Codex-first，但 core 已经按 agent-ready 方向拆分：

- Codex CLI：v1 唯一真正可运行的后端。
- Codex MCP / plugin：`integrations/codex` 提供基础包装。
- Claude Code：`integrations/claude` 提供 MCP 配置模板和 skill 草案。
- Cursor：`integrations/cursor` 提供 MCP 配置模板和 rules 草案。

`ClaudeCodeBackend` 和 `CursorAgentBackend` 当前只是 typed extension points。只有当执行、resume、interrupt 和凭据语义明确后，才会实现真实 backend。

## 当前边界

- 只处理绑定微信号本人的私聊消息。
- 默认忽略群聊、陌生人、非绑定用户和 bot 消息。
- 不做多用户共享、团队协作、公共 bot 或远程托管。
- daemon 默认以当前登录用户身份运行。
- `setup` 和 `start` 会检查 `codex` 是否存在、Codex 登录态、默认 cwd 和 allowlist。
- `/cwd` 只能切到 allowlist 中的 Git repo root。
- 默认不启用 `--skip-git-repo-check`。

这些边界是 v1 的安全默认值，不是临时限制。

## 工作原理

```text
微信私聊消息
  ↓
WeChatMonitor 拉取消息
  ↓
BridgeService 过滤用户、处理 slash command 或普通 prompt
  ↓
AgentService 调用当前 AgentBackend
  ↓
CodexExecBackend 执行 codex exec / codex exec resume
  ↓
StreamBuffer 节流同步进度
  ↓
WeChatSender 回传结果
```

MCP server 复用同一组 core services，不复制业务逻辑，也不绕过 allowlist 和 session 规则。

## 仓库结构

```text
.
├── README.md
├── README_EN.md
├── README_JA.md
├── README_KO.md
├── README_ES.md
├── docs/
│   ├── architecture.md
│   ├── design-process.md
│   ├── implementation-plan.md
│   ├── integrations.md
│   └── mcp.md
├── integrations/
│   ├── claude/
│   ├── codex/
│   └── cursor/
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

- [docs/design-process.md](docs/design-process.md): 项目设计演进记录。
- [docs/architecture.md](docs/architecture.md): 当前架构边界。
- [docs/mcp.md](docs/mcp.md): MCP server 和工具契约。
- [docs/integrations.md](docs/integrations.md): Codex / Claude / Cursor integration 策略。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
```

## 参考架构来源

本项目参考 `wechat-claude-code` 的微信协议、session、daemon、分片和 monitor 分层思路，但替换了 Claude/Anthropic provider：

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
