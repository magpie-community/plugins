# opencode-antigravity-acp-auth

[English](README.md) | 简体中文

一个 magpie（OpenCode）供应商插件：**通过 Google Antigravity 官方的 ACP 服务器使用 Antigravity** —— 即 Antigravity IDE 所依赖的 agent runtime（`agy_acp_server.par`，由 dl.google.com 分发），以 Agent Client Protocol v1 驱动。

改编自 [`pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider)（MIT）：固定的运行时清单、运行时发现顺序与安装/验证流程、模型家族折叠算法、无头 OAuth relay，以及 ACP 会话生命周期的部分内容均派生自它，并按 magpie 的插件契约重塑。其许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

> **需要安装并登录 Antigravity IDE（用你的 Google 账号）。** ACP 服务器搭载 IDE 的 Google 登录 —— 这是受支持且经当前服务器（1.2.1）实测验证的路径。插件会自行下载 Google 官方的 `agy_acp_server.par`；插件不驱动 IDE，IDE 是凭据所在。

## 前置要求

- **已安装并登录的 Antigravity IDE。** 见上方说明。用 *Sign in with Google*（或 *Use Antigravity's current Google sign-in*）登录本插件；IDE 已登录的机器上，服务器会即刻应答。
- **Bun** —— magpie 的插件运行在其上，会自动安装。
- **`unzip`**（仅 Linux）用于运行时的一次性解压。
- 首次登录会下载官方 ACP 服务器（压缩包约 112 MB，落盘约 400 MB，macOS arm64）到 `~/.local/opt/agy-acp/`。

## 工作方式

- **登录**：Google 登录归 ACP 服务器所有，存放在哪里也由它独自决定（IDE 已登录的安装通常完全没有令牌文件）；插件只存一个标记，绝不存令牌，并从服务器自己的应答读取登录健康 —— 未登录也能建会话，但只有真凭据才能让 prompt 通过。一台机器上的本供应商所有账户共享同一个 Google 登录。三种登录方式：
  - *Sign in with Google* —— 服务器对已登录 IDE 提供的凭据做认证，即刻应答；没有时它会自己驱动浏览器。在 SSH 或无头 Linux 上，OAuth URL 会被捕获并展示，把最终的 localhost URL 粘贴回来即可。
  - *Use Antigravity's current Google sign-in* —— 复用 Antigravity IDE 在本机已完成的登录。
  - *Gemini API key* —— 以 `_meta.api-key` 向服务器认证。
- **运行时**：按 `AGY_ACP_BIN`、`~/.local/opt/agy-acp/current`、`~/.local/bin/agy_acp_server.par`、`PATH` 的顺序查找。都没有时，下载 `runtime-manifest.json` 固定的版本（校验 SHA-256 与精确字节数，解压出的服务器先经 ACP 验明身份再启用）到 `~/.local/opt/agy-acp/versions/`，并链接为 `current`。Linux 解压需要机器上有 `unzip`。
- **请求**：每个请求都是模型的 OpenAI Chat body（模型声明在 `@ai-sdk/openai-compatible` 上）。插件把它翻译成一次 ACP 会话：历史作为一块嵌入式 markdown 上下文，最后一条用户消息的文本与图片作为 prompt 块，回复以 OpenAI 分块流回 —— `agent_message_chunk` 对应 content，`agent_thought_chunk` 对应 `reasoning_content`，prompt 的 usage 与配额在末块。会话为单个请求所有；请求结束时插件会请服务器关闭它。
- **失败路径**：在回复尚未流出任何内容之前的 prompt 失败会作为失败请求抛出 —— 登录失效会把账户标记为 expired，服务器中途退出会在新服务器上重试一次。回复一旦开始，错误只作为回复末尾附注。超出时限的 prompt 会在服务器上被取消，而不是连服务器一起杀掉。
- **模型**：服务器带 effort 后缀的 id 折叠为每家族一条（`gemini-3.8-flash-low/-medium/-high` 变成 `gemini-3.8-flash`，带 low/medium/high variants）；请求的 `reasoning_effort` 在会话上选中对应的确切 id。
- **工具**：请求携带的工具经回环 MCP bridge 提供给 agent。agent 在那里发起调用，即成为回复的 `tool_calls` 并结束回合，与聊天客户端的预期一致。Antigravity 自己的工具被拒之门外（`session/request_permission` 一律回答 *cancelled*），因此本机上只有客户端 agent 要求执行的东西会运行。
- **用量**：上一次 prompt 应答携带的配额（`_meta.quota`）显示在账户的 Usage 卡片上。

## 限制

- 一台机器一个 Google 登录，本供应商所有账户共享；"换账号"意味着把整台机器登成另一个人。
- Antigravity 自己的文件与命令工具永远不会执行；模型坚持要用时会说明它做不到。真正被提供的是客户端 agent 的工具。
- 会话不跨请求保温：每个请求把整段对话作为上下文携带，如同无状态的模型 API。每个请求在自己的 ACP 会话里运行，请求结束后插件会请服务器关闭它；关闭后的会话是否仍留在 IDE 的会话历史里由服务器决定（未对真实服务器验证）。

## 封号风险，以及 magpie 内置的 Antigravity

导致账号被封的，是 Google 看到账号在 Antigravity 之外被使用。magpie 内置的 `antigravity` 供应商自己就这么警告（"用一个你丢得起的账号"）：它用自己的代码连接 Google 的 Code Assist API，戴着伪造的 `antigravity/hub/<version>` User-Agent。

本插件在这条轴上低一档 —— 发给 Google 的每一个字节都来自 Google 官方的服务器二进制，走服务器自己的认证，写入 IDE 使用的同一套会话存储。**但不等于零**：服务器仍然看得到外部 agent 的系统提示词与工具定义、脚本化的调用节奏，以及一个名字不是 IDE 的客户端，而 Google 随时可以加入服务器端检测。两个供应商可以共存；账号分开用，并且用你丢得起的账号。

| | 内置 `antigravity` | 本插件 `antigravity-acp` |
| --- | --- | --- |
| 以什么身份对接 Google | magpie 自己的代码，伪造 IDE 头 | 官方 ACP 服务器二进制 |
| 认证 | 账号的 OAuth 令牌，由 magpie 刷新 | 服务器自己的流程，搭载 IDE 的 Google 登录 |
| 账号 | 池化，各账号模型目录合并 | 一机一 Google 登录，共享 |
| 模型 | 账号池合并 + magpie 内置家族折叠 | 服务器实时 rollout 目录，插件内折叠 |
| 用量 | 配额端点、tier 卡片 | 每次 prompt 应答携带的配额 |
| 工具调用 | 提供给模型 API | 客户端工具经回环 MCP bridge；Antigravity 自有工具被拒绝 |
| 第三方账号导入 | 支持（Antigravity Manager、CLIProxyAPI） | 不支持 —— 登录归服务器所有 |
| 额外依赖 | 无 | 下载的官方运行时（约 400 MB）+ 一个子进程 |

## 环境变量

- `AGY_ACP_BIN` —— 你自己的 `agy_acp_server.par`，优先于一切。
- `AGY_ACP_HOME` —— 同时迁移 `~/.gemini` 与 `~/.local`（沙箱、测试）。
- `AGY_ACP_AUTH_DIR`、`AGY_ACP_RUNTIME_ROOT` —— 分别迁移登录与托管运行时。
- `AGY_ACP_OAUTH_MODE` —— `manual`（relay，回贴 URL）或 `browser`（让服务器开浏览器）。

## 测试

```sh
bun test   # 全插件对着一个假 ACP 服务器跑；不下载、不登录 Google
```

## 许可

MIT —— 见仓库根目录的 [LICENSE](../../LICENSE)。改编自 `pi-antigravity-acp-provider`（MIT）；其声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
