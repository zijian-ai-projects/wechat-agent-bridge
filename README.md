# wechat-codex-bridge

个人微信 `<->` 本机 Codex CLI daemon 桥接器。v1 是单用户产品：只服务一个绑定微信号和当前系统用户的本机 Codex 登录态。

## V1 边界

- 只处理绑定微信号本人的私聊消息：`msg.from_user_id === boundUserId`。
- 默认忽略群聊、陌生人、非绑定用户、bot 消息。
- 不做多用户共享、团队协作、公共 bot 或 system 级共享服务。
- daemon 默认以当前登录用户身份运行，以复用该用户已有的 Codex CLI 登录缓存。

## 运行前提

1. Node.js 20+。
2. 已安装本机 `codex` CLI。
3. 推荐先在终端完成：

```bash
codex login
```

如果浏览器回调不方便：

```bash
codex login --device-auth
```

然后再启动本项目：

```bash
npm install
npm run setup
npm run start
```

## 登录方式优先级

本项目不能也不会设计成 API key-only。

优先级：

1. 当前系统用户已有的 Codex CLI ChatGPT 登录态。
2. 当前系统用户已有的 Codex CLI API key 登录态。
3. API key 仅作为 Codex CLI 自身支持的可选 fallback，不是默认路径。

`setup` 和 `start` 会先检查 `codex` 是否存在，再运行 `codex login status`。如果检测到 `Logged in using ChatGPT`，会直接按 ChatGPT 登录态运行，不要求 `OPENAI_API_KEY`，也不会用 API key 覆盖。

## 本地运行

```bash
npm run typecheck
npm test
npm run setup
npm run start
```

后台运行：

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
```

后台 daemon 也是用户级进程，默认复用当前用户的 Codex 登录态。不要把 v1 当成 system 级共享服务运行。

## Setup / Start 自检

失败会返回清晰错误，不静默降级。

- `codex` 是否存在。
- `codex login status` 是否为 ChatGPT 或 API key 登录。
- 默认 cwd 是否存在且可访问。
- 默认 cwd 是否在 allowlist repo roots 内。
- 默认 cwd 是否为 Git repo root 或位于 Git repo 内；setup 会保存 repo root。
- `/cwd` 只能切到 allowlist 中的 Git repo root。

默认不传 `--skip-git-repo-check`。只有未来显式配置并确认某个 allowlist 目录允许跳过时，才会考虑该能力；v1 默认不启用。

## 允许写入兄弟目录

`workspace` 模式下，Codex 默认只能写当前 `cwd`。如果你要让它创建或修改兄弟目录，例如：

```text
/Users/lixinyao/.codex/projects/SageTalk
```

需要在 `~/.wechat-codex-bridge/config.json` 里显式配置 `extraWritableRoots`。如果目标目录还不存在，要把它的父目录加入额外可写根：

```json
{
  "defaultCwd": "/Users/lixinyao/.codex/projects/wechat-codex-bridge",
  "allowlistRoots": [
    "/Users/lixinyao/.codex/projects/wechat-codex-bridge"
  ],
  "extraWritableRoots": [
    "/Users/lixinyao/.codex/projects"
  ],
  "streamIntervalMs": 10000
}
```

然后重启 daemon：

```bash
npm run daemon -- restart
```

`extraWritableRoots` 会被转换为 `codex --add-dir <path>`，只在 `workspace` 模式下用于 sandbox 额外写入范围。

## Codex 模式

- `readonly` 默认：`--sandbox read-only --ask-for-approval never`
- `workspace`：`--sandbox workspace-write --ask-for-approval never`
- `yolo`：`--dangerously-bypass-approvals-and-sandbox`

只有显式发送 `/mode yolo` 后才启用 yolo，并会返回危险警告。

## Slash Commands

- `/help`
- `/clear`
- `/status`
- `/cwd [path]`
- `/model [name]`
- `/mode [readonly|workspace|yolo]`
- `/history [n]`

`/clear` 会丢弃旧 Codex session/thread id，下次普通消息开启全新会话。非 `/clear` 的继续对话优先使用 `codex exec resume <SESSION_ID>`。

## 认证排查

如果 `setup` 或 `start` 提示未登录：

```bash
codex login status
codex login
```

浏览器回调不方便时：

```bash
codex login --device-auth
```

如果前台能用、后台 daemon 不能读取登录态，通常是后台环境无法访问当前用户 keyring。请确认 daemon 是当前用户启动的；必要时按 Codex CLI 配置将 `cli_auth_credentials_store` 切到 `file`。file 模式只应读取 `CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`，并确保权限为 `0600`。

日志永远不应包含 `auth.json` 内容、token、refresh token、cookie 或 Authorization header。

## 安全默认值

- 微信文本只作为 Codex prompt 传入，绝不当 shell 拼接执行。
- 只有 Codex 自己决定是否调用命令。
- 配置、账号、session、sync buffer 以 `0600` 写入。
- 所有路径做 normalize + `realpath` 校验。
- stdout JSONL 和 stderr 日志严格分离：`codex exec --json` 只解析 stdout JSONL，stderr 只用于日志和错误信息。

## 参考架构来源

本项目参考 `wechat-claude-code` 的微信协议、session、daemon、分片和 monitor 分层思路，但替换了 Claude/Anthropic provider：

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
