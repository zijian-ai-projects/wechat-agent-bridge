# wechat-agent-bridge

> 把个人微信私聊连接到本机 coding agent daemon，让你可以从微信控制本机 Codex，并通过 MCP 接入其他 agent 客户端。

其他语言 / Other Languages:
[English](README_EN.md) · [日本語](README_JA.md) · [한국어](README_KO.md) · [Español](README_ES.md)

wechat-agent-bridge 是一个个人本地桥接器：它监听一个绑定微信号的私聊消息，把普通消息交给本机 coding agent 执行，并把进度和结果回传到微信。

它现在支持基于 `projectsRoot` 的多项目会话：你可以把 `wechat-agent-bridge`、`SageTalk` 这样的本地仓库放到同一个项目根目录下，并分别保留各自的 Codex session、history、mode 和 model。

它不是公共 bot，也不是团队共享服务。v1 默认使用 Codex CLI 后端，只服务一个绑定微信号和当前系统用户的本机 Codex 登录态。

## 3 分钟上手

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` 会完成三件事：

1. 检查本机 Codex 登录
2. 绑定微信
3. 选择项目根目录和默认项目

如果浏览器回调不方便，可以先在终端完成：

```bash
codex login --device-auth
```

## 安装与部署

### 前置条件

- Node.js 20 或更高版本
- npm
- 本机已安装 `codex` CLI，并且用运行 bridge daemon 的同一个 OS 用户完成 `codex login`
- 一个用于绑定的个人微信账号
- 一个 `projectsRoot` 目录，本地项目作为一级子目录放在里面

### 从源码安装

```bash
git clone https://github.com/zijian-ai-projects/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
npm run build
```

首次运行先初始化本地配置和微信绑定：

```bash
npm run setup
```

`setup` 会把配置、账号和会话数据写到 `~/.wechat-agent-bridge`。这些文件包含本机状态和账号信息，不要提交到 Git，也不要共享给其他用户。

### 本地前台运行

```bash
npm run start
```

适合调试或临时使用；终端关闭后 bridge 也会停止。

### 后台 daemon 部署

```bash
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- restart
npm run daemon -- stop
```

v1 不会自动安装 systemd、launchd 或 Windows service。它是用户级 daemon，应以完成 `codex login` 的同一个 OS 用户运行。若从外部进程管理器或登录脚本启动，建议使用绝对路径：

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run daemon -- start
```

更新部署：

```bash
git pull
npm install
npm run build
npm run daemon -- restart
```

从源码运行桌面同步终端时，如果没有全局 link，可以直接使用构建后的入口：

```bash
node dist/src/main.js attach
node dist/src/main.js attach SageTalk
```

如果希望直接使用 `wechat-agent-bridge attach`，可以在仓库目录执行一次：

```bash
npm link
```

## 微信里怎么用

```text
/project
/project SageTalk
/model
/model gpt-5.5
/models
@SageTalk 帮我看一下测试失败原因
```

不带 `@项目名` 的普通消息，会发给当前项目。
`/model` 会显示当前项目实际使用的模型和来源；`/model <name>` 会切换当前项目模型；`/models` 会读取本机 Codex 可用模型目录。

完整命令说明见 [docs/commands.md](docs/commands.md)。

## 项目目录规则

- 只读取 `projectsRoot` 下的一级子目录
- 新项目放进去后就能在 `/project` 里看到
- 非 Git 目录第一次使用时，需要显式发送 `/project <name> --init`
- 启动时优先恢复上次使用的项目；第一次运行时由 `setup` 选择默认项目

## 后台 daemon

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

配置、账号、session、runtime state 和 sync buffer 会以 `0600` 写入。日志会脱敏，不能包含 token、cookie、Authorization header 或 Codex auth 文件内容。

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
  "projectsRoot": "/Users/you/.codex/projects",
  "defaultProject": "wechat-agent-bridge",
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

## 桌面同步终端

启动 daemon 后，可以在电脑终端连接同一个 bridge runtime：

```bash
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

带项目名启动时会先切换到该项目；连接后也可以用 `:project <name>` 切换。

普通输入会作为当前项目 prompt 执行。以 `:` 开头的是本地控制命令：

```text
:status
:project SageTalk
:model
:model gpt-5.5
:models
:interrupt
:replace 重新按这个方向做
```

`:model` 不带参数时显示当前项目模型状态；`:model <name>` 会切换当前项目模型。

微信发起的任务会同步显示在 attach 终端；attach 发起的任务会同步显示到微信。两端共享同一个项目 session、mode、model 和运行中 turn。

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
- `setup` 和 `start` 会检查 `codex` 是否存在、Codex 登录态，以及配置的 `projectsRoot`。
- `/cwd` 是兼容命令，只能切到已配置项目的目录。
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

MCP server 复用同一组 core services，不复制业务逻辑，也不绕过项目和 session 规则。

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
