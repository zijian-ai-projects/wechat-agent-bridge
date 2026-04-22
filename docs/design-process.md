# Design Process

本文记录 `wechat-agent-bridge` 从一个可运行的个人 WeChat-to-Codex v1，逐步演进为 core + MCP + thin adapters 架构的设计过程。

## 初始问题

最早的目标很具体：通过个人微信私聊控制本机 Codex CLI，让移动端也能安全地把任务交给本机 agent。这个目标决定了 v1 的产品边界：

- 只服务一个绑定微信号和当前系统用户。
- 只处理绑定用户的私聊消息。
- 默认忽略群聊、陌生人、非绑定用户和 bot 消息。
- daemon 以当前登录用户身份运行，复用本机 Codex CLI 登录态。
- 不做公共 bot、多用户共享、团队权限或远程托管服务。

这个边界让项目可以先可靠运行，而不是一开始就承担多租户、跨平台和权限系统的复杂度。

## V1 设计

v1 的核心链路是：

```text
WeChat private message
  -> message filter
  -> slash command router or ordinary agent prompt
  -> CodexExecBackend
  -> streamed progress and final reply
  -> WeChat sender
```

第一版保留了这些用户可见命令：

- `/help`
- `/clear`
- `/status`
- `/cwd`
- `/model`
- `/mode`
- `/history`

`/mode` 只支持 `readonly`、`workspace`、`yolo`。默认是 `readonly`，`yolo` 必须显式启用。

## 安全边界

后续设计首先补强的是运行安全，而不是平台扩展。

关键决策：

- 认证优先复用终端已登录的 Codex 账号态。
- `OPENAI_API_KEY` 不是默认路径，只是 Codex CLI 自身支持的 fallback。
- `setup` 和 `start` 都要检查 `codex` 是否存在、是否已登录、cwd 是否合法。
- 默认 cwd 必须是 allowlist 中的 Git repo root。
- `/cwd` 只能切到 allowlist roots。
- 默认不传 `--skip-git-repo-check`。
- 微信文本只作为 prompt 传给 agent，bridge 不把文本拼成 shell 命令。
- stdout JSONL 和 stderr 严格分离：只解析 `codex exec --json` 的 stdout。
- 日志继续脱敏，不能泄漏 token、cookie、Authorization header 或 Codex auth 内容。

这些约束让后续抽象不会削弱 v1 的安全默认值。

## Codex Backend

v1 保持唯一真正可运行的 backend：

```text
AgentBackend
  -> CodexExecBackend
```

`CodexExecBackend` 负责：

- `codex exec --json`
- `codex exec resume --json`
- `SIGINT` 软中断
- 超时后 `SIGKILL`
- Codex JSONL event 格式化

普通消息到达时，如果旧 turn 仍在 `processing`，bridge 会先 interrupt 旧进程，再开始新 turn。`/clear` 会丢弃旧的 Codex session/thread id，确保下一条普通消息开启新会话。

后面新增了 `extraWritableRoots`，用于把显式配置的兄弟目录传给 Codex：

```text
codex --add-dir <path>
```

这只在 `workspace` 模式下启用，避免为了写兄弟目录而直接切到 `yolo`。

## 抽出 Core

随着项目目标从 Codex-only 演进为 multi-agent-ready，`runtime/bridge.ts` 变得过重。它原来同时承担：

- WeChat 消息过滤
- 命令路由
- session 状态变更
- history 维护
- agent start/resume/interrupt
- stream buffer
- daemon 装配

因此设计上把运行时拆成 core services：

```text
src/core/
  BridgeService.ts
  AgentService.ts
  SessionService.ts
  WechatService.ts
  ModeService.ts
  errors.ts
  types.ts
```

拆分原则：

- `BridgeService` 保留 v1 行为：消息过滤、命令处理、普通消息转 agent turn。
- `AgentService` 统一 start/resume/interrupt，并保留 stale resume fallback。
- `SessionService` 包装 session status、history、clear、save。
- `ModeService` 管理 mode、model、cwd，并复用 allowlist 校验。
- `WechatService` 提供绑定状态和运行状态视图。
- `runtime/bridge.ts` 只负责装配：加载配置、账号、session，启动 WeChat monitor，处理 shutdown。

这个阶段的目标是“不改行为地抽象”，而不是重写。

## MCP 设计

抽出 core 后，下一步是把同一组能力暴露成本地 MCP server。这样 Codex、Claude、Cursor 或其他 MCP client 都可以通过统一工具接口调用 bridge，而不需要直接依赖内部模块。

MCP 工具集：

- `wechat_status`
- `wechat_bind_status`
- `wechat_history`
- `session_clear`
- `agent_resume`
- `agent_interrupt`
- `agent_set_mode`
- `agent_set_cwd`

工具返回统一结构：

```json
{ "ok": true, "data": {} }
```

或：

```json
{ "ok": false, "error": { "code": "INVALID_ARGUMENT", "message": "..." } }
```

设计决策：

- MCP tool 直接调用 core service。
- 不在 MCP 层重复实现业务逻辑。
- 错误返回机器可读。
- stdio MCP server 使用 `npm run mcp` 启动。
- stdout 保留给 MCP JSON-RPC，不输出普通日志。

## Integrations

平台兼容被拆成两层：

1. core + MCP 是真正稳定的共享能力。
2. `integrations/` 是平台薄包装层。

当前状态：

- `integrations/codex`: 最完整，包含 Codex plugin scaffold、MCP config template、skill 文档。
- `integrations/claude`: 先放 MCP template、skill 草案和工具映射说明。
- `integrations/cursor`: 先放 MCP template、rules/command mapping 草案。

没有为了“看起来支持三平台”去实现假的 Claude/Cursor backend。`ClaudeCodeBackend` 和 `CursorAgentBackend` 目前只是 typed extension points，只有当执行、resume、interrupt 和凭据语义明确后才会实现。

## Rename

项目最初叫 `wechat-codex-bridge`。当目标从 Codex-only 变成 platform-neutral core + MCP + adapters 后，这个名字开始限制后续演进。

最终命名改为：

```text
wechat-agent-bridge
```

原因：

- `wechat` 保留当前产品入口。
- `agent` 覆盖 Codex / Claude / Cursor 等本地 coding agent。
- `bridge` 准确表达连接 WeChat、core、MCP 和 backend 的职责。
- kebab-case，适合作为 package name、MCP server id、plugin id 和 skill namespace。

迁移时保留了兼容环境变量：

- 新：`WECHAT_AGENT_BRIDGE_HOME`
- 旧：`WECHAT_CODEX_BRIDGE_HOME`
- 新：`WECHAT_AGENT_BRIDGE_DEBUG`
- 旧：`WECHAT_CODEX_BRIDGE_DEBUG`

## 测试驱动

每个阶段都用测试约束行为：

- 绑定用户私聊才处理。
- 群聊、陌生人、bot 消息被忽略。
- 新普通消息会 interrupt 旧 turn。
- `/clear` 丢弃旧 session/thread id。
- stale resume 会 fallback 到 fresh turn。
- cwd allowlist 仍生效。
- Codex login 自检仍复用当前 CLI 登录态。
- MCP tools 返回稳定结构。
- Codex 是唯一 runnable backend，Claude/Cursor 只是 extension points。
- 项目命名不能回退到旧 Codex-only 名称。

最终验证命令：

```bash
npm run typecheck
npm test
npm run build
```

此外还做了 MCP smoke test，确认编译后的 MCP server 能响应 `initialize` 和 `tools/list`。

## 当前结论

项目现在处在一个增量演进点：

- v1 仍能通过微信私聊控制本机 Codex CLI。
- core 已经从 daemon runtime 中抽出。
- MCP server 已经可启动。
- Codex integration 有基础包装。
- Claude/Cursor 有模板和文档，但还不是 runnable backend。
- 项目命名已经从 Codex-only 调整为 agent-ready。

下一步可以继续做：

- 把 Codex integration 变成更完整的 installable plugin/marketplace 形态。
- 为 MCP server 增加更完整的协议级集成测试。
- 在明确 Claude/Cursor 执行语义后，再实现真实 backend。
- 根据实际使用反馈决定是否支持多账号、多用户或远程部署；这些都不属于 v1 默认边界。
