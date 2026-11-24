# magpie-junie

把 **JetBrains Junie** 接入 magpie 的供应商插件（`junie`）。

直连 Grazie 上游时，free tier 账号（`licenseType:NONE`）会被 403 拒绝；但 Junie CLI 内部的 `junie-lite` 通道可以正常回答。因此本插件提供两种模式：

- **桥接模式（推荐，free tier 可用）**：随附 `bridge-server.mjs` 启动一个本地 OpenAI 兼容服务，后端调 CLI headless 的 `junie-lite` 通道；插件配 `bridgeUrl` 后把请求转给它。CLI 版本由桥接服务自动保鲜（6h 检查 + 自动更新）。
- **直连模式**：基于逆向项目 [fabienfleureau/junie-api](https://github.com/fabienfleureau/junie-api) 的上游抓包事实，直接请求 `ingrazzio-cloud-prod.labs.jb.gg` 的原生端点，需有效订阅 + 代理。

> ⚠️ **风险声明**：Junie/Grazie 是 JetBrains 商业订阅服务，本项目不受 JetBrains 支持，可能随时失效。过度自动化或脚本化使用可能违反 [JetBrains AI Service Terms](https://www.jetbrains.com/legal/docs/terms/jetbrains-ai-service/)。请只用于自己的订阅，并自行承担账号风险。

## 登录方式

按优先级提供三种（在 magpie 里给 `junie` 添加账号时选择）：

1. **从本机 Junie CLI 导入登录态**（推荐）——读取 `~/.junie/dpapi_credentials/*.dpapi`，用 Windows DPAPI 解密出 JetBrains OAuth token。本机装了 [Junie CLI](https://junie.jetbrains.com) 且登录过就可以直接用，不用浏览器。
2. **浏览器登录（JetBrains 账号）**——复刻 Junie CLI 的 PKCE 授权码流程，本地回调端口 62345–62364。
3. **API key (`perm-*`)**——从 https://junie.jetbrains.com/cli 获取，直接粘贴。

登录信息保存在 magpie 的 `plugin-auth.json`（权限 600），与 OpenCode auth.json 格式兼容。token 过期前由 magpie 的 `auth.refresh` 自动续期（提前 90 秒）。

## 模型与请求

| 模型 | 上游路径 |
|---|---|
| `claude-sonnet-4-6`、`claude-opus-4-6` | `POST /v1/messages`（Anthropic 原生直通） |
| `openai-gpt4.1`、`openai-gpt4.1-mini`、`openai-gpt-4o` | `POST /v1/chat/completions`（OpenAI 原生直通，profile id 映射到真实模型名） |
| `Qwen/Qwen3.6-27B-FP8` | `POST /llm/vllm/v1/chat/completions`（CLI 4100.11 实测） |
| `google-chat-gemini-pro-2.5`、`google-chat-gemini-flash-2.5` | 需在插件选项里设 `passthroughOnly: false`（Grazie 原生翻译，实验性） |

流式（SSE）与非流式都支持：上游响应原样透传。请求头带 Junie CLI 抓包得到的 `Grazie-Agent` 等固定字段；上游返回 477（免费 Google 档不可用）时自动去掉 `X-Free-Google-Api` 重试一次。

额度显示走 `GET /auth/test`：`plan` = licenseType、`balance` = balanceLeft + unit。上游不提供窗口百分比，所以用量窗口为空（不编造 `used: 0`）。账号无有效订阅时会显示 `NO_LICENSE` 提示。

## 安装

```sh
magpie plugin add magpie-junie
# 或开发时
magpie plugin add ./magpie-junie
```

## 重要：代理

Junie 上游对中国大陆 IP 直连返回 **403**，`/auth/test` 也一样。需要让插件的 fetch 走代理：

- Node 24 可用 `NODE_USE_ENV_PROXY=1`（读取 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量）。
- magpie 宿主（Bun）下请确认其代理设置对本插件生效；否则上游会返回 403 HTML。
- 本机调试时可用 `scripts/verify-cli-import.mjs` 验证凭据导入、`NODE_USE_ENV_PROXY=1 node scripts/verify-refresh-pkce.mjs` 验证续期。

## 开发

```sh
npm test          # node --test
bun test          # 双通道
node scripts/verify-cli-import.mjs   # 真机验证 CLI 登录态导入（不打印 token）
NODE_USE_ENV_PROXY=1 node scripts/verify-refresh-pkce.mjs  # 真机验证续期/PKCE URL
```

## 许可证

MIT — 本插件自身代码。Junie 与 JetBrains 是 JetBrains s.r.o. 的商标。

## 本地桥接服务（junie-lite 通道）

直连 Grazie 上游会因 `licenseType:NONE` 被 403 拒绝；但 Junie CLI 内部的 `junie-lite` 通道可以正常回答。本仓库提供 `bridge-server.mjs`，把 OpenAI chat completions 翻译成一次 CLI headless 调用：

```sh
node bridge-server.mjs                  # 默认 127.0.0.1:4141
PORT=4142 JUNIE_MODEL=junie-lite node bridge-server.mjs
```

接口：

- `GET /health` — 健康检查
- `GET /v1/models` — 返回 `junie-lite`
- `POST /v1/chat/completions` — OpenAI 兼容（支持 `stream: true`）

配置（环境变量）：`PORT`、`HOST`、`JUNIE_BIN`（默认 `C:\Users\Robin\.local\bin\junie.bat`）、`JUNIE_MODEL`（默认 `junie-lite`）、`JUNIE_TIMEOUT_MS`（默认 120000）。

**前置条件**：CLI 版本必须支持 free 模型。CLI 26.11.2 (4100.11) 实测被上游拒绝（`Your version of Junie doesn't support this free model, please update it first`），需升级到 26.11.3+。服务返回 `errors` 数组里的原始原因即 CLI 的报错。

技术要点：CLI 的 stdin 必须是真实文件（不能用 pipe，否则 Windows 报 `java.io.IOException: 函数不正确`）；`.bat` 必须经 `cmd /c` 执行；CLI stdout 混有日志，需解析其中 JSON 行。

## CLI 版本自动维护

桥接服务依赖 CLI 版本满足上游 free 模型门槛。服务内置自动版本维护（无需 Windows 计划任务或外部调度）：

- 服务启动时后台检查一次 CLI 版本；每次对话前也会检查（**6 小时节流**）。
- 发现新版本自动执行 `junie update` 并切换，同时清理上次中断留下的半成品下载文件。
- 状态写在 `~/.config/magpie/junie-update-check.json`，`/health` 可查看最近检查结果。

关闭自动更新：`JUNIE_AUTO_UPDATE=off node bridge-server.mjs`；改间隔：`JUNIE_UPDATE_INTERVAL_MS=3600000`（毫秒）。
