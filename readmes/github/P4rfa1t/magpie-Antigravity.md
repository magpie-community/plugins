# <img src="docs/logo.svg" width="28" height="28" align="top" alt="" /> magpie-Antigravity

[![Test Suite](https://github.com/P4rfa1t/magpie-Antigravity/actions/workflows/test.yml/badge.svg)](https://github.com/P4rfa1t/magpie-Antigravity/actions/workflows/test.yml) [![UA & Protocol Sync](https://github.com/P4rfa1t/magpie-Antigravity/actions/workflows/antigravity-ua-sync.yml/badge.svg)](https://github.com/P4rfa1t/magpie-Antigravity/actions/workflows/antigravity-ua-sync.yml) [![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-3b82f6?style=flat-square)](https://usemagpie.ai/) [![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-8b5cf6?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/) [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6366f1?style=flat-square)](https://github.com/P4rfa1t/magpie-Antigravity) [![License: MIT](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](LICENSE)

中文 | [English](README.en.md) | [贡献与反馈指南](CONTRIBUTING.md) | [技术架构与交接文档](HANDOFF.md)

面向 [Magpie](https://usemagpie.ai/) 与 **OpenCode** 的独立、零外部依赖 Google 模型插件（npm 包名 `magpie-antigravity`）。以 **Antigravity**（`antigravity-rt`）为核心——纯 JS 通过 Google OAuth 浏览器授权与 Refresh Token 直连 Cloud Code `v1internal` 接口，免本地二进制与 `agy` CLI 额外系统提示词开销，开箱提供 **Gemini 4**、**Claude 5.5**、**GPT-OSS**、原生工具调用、图像生成、高命中率隐式前缀缓存与每日零凭据官方协议/UA 自动同步；同时保留 **Gemini Web**（`gemini-web`）作为网页版 Cookie 补充通道。

> **独立仓库说明**：本项目已由 `P4rfa1t/magpie-Antigravity` 作为独立项目维护（不再作为分支运行），并已移除原 AI Studio (`ai-studio`) 模块，全面聚焦 **Antigravity** 直连稳定性、协议一致性与 **Gemini Web** 兼容支持。

---

## 怎么选？

插件导出两个相互独立、可同时启用的 Provider：

| 对比项 | Antigravity (`antigravity-rt`) — **主力推荐** | Gemini Web (`gemini-web`) — 网页补充通道 |
| :--- | :--- | :--- |
| **适用场景** | **主力对话、Coding Agent、多模型统一调度（免下载本地二进制）** | 日常对话、复用 Gemini 网页版订阅额度 |
| **主要模型** | `gemini-4-neon`、`gemini-4-hydrogen`、`gemini-4-argon`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5`、`gpt-oss-120b-medium` 等（动态同步上游目录） | `gemini-4-hydrogen`（含免费登录账号）、`gemini-4-carbon` / `gemini-4-neon`（付费 / Ultra）、`gemini-3.6-flash`、`gemini-3.5-flash-lite` |
| **工具调用** | **原生 Function Calling**（自动 `$ref` 展开、预算收敛、`thoughtSignature` LRU 持久化） | 提示词模拟（实验性，Flash 系列常不调工具） |
| **思考档位** | `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（按模型变体自动折叠与映射） | `low`（普通）/ `medium`（`-thinking-medium`，仅 `gemini-4-argon`）/ `high`（`-thinking` 扩展思考） |
| **图片输入** | 默认开启，支持多模态对话与 PDF `inlineData` | 默认开启，对话模型可以读图（需登录态 Cookie） |
| **图片生成** | `gemini-3.1-flash-image`（OpenAI 与 Gemini Native 双入口） | 不支持 |
| **登录方式** | **Google OAuth 浏览器授权**（自动回环回调 / 手动粘贴回调链接）与 **Refresh Token 导入**（单个 / JSON 批量） | 在无痕窗口登录 `gemini.google.com` 并复制 `cookie` |
| **额度卡片** | 同步 **5 小时** 与 **每周** 配额（Gemini / Claude & GPT / Argon，仅展示不锁死路由） | 同步网页版 **5 小时** 与 **每周** 用量及重置时间 |
| **本地依赖** | **无需下载本地二进制**（纯 Node/Bun 直连 `v1internal`，支持 ALPN `h2` 代理复用） | `gemini-web2api-go`（Go 本地守护进程，支持官方上游版或自建优化版） |

---

## 快速开始

### 安装插件

将本仓库克隆到本地后，在 Magpie 中从本地目录添加插件（或直接通过 Git 仓库地址添加）：

```bash
git clone https://github.com/P4rfa1t/magpie-Antigravity.git
magpie plugin add ./magpie-Antigravity
```

> 也可直接使用导出入口：`GeminiWebPlugin`（默认导出）与 `AntigravityPlugin`（命名导出）。插件保持 **零运行时 npm 依赖**，支持 Node.js >= 22 与 Magpie 内置 Bun 运行时。

---

### 方式一：Antigravity (`antigravity-rt` — 推荐主力)

1. 在 Magpie 的 **「来自插件」** 区域找到 **Antigravity**（使用独立 ID `antigravity-rt`，不与 Magpie 内置订阅 `Antigravity` 冲突），任选以下登录方式：
   - **「通过 Google OAuth 浏览器授权登录（推荐）」**：自动拉起本地 `http://localhost:<端口>/oauth-callback` 监听，在浏览器登录 Google 并点击允许授权后自动换取 Refresh Token 并保存账号；
   - **「通过 Google OAuth 授权（手动粘贴回调链接 / Code）」**（容器或远程环境会自动置顶）：在任意本地浏览器完成 Google 授权后，将地址栏跳转后的完整回调链接（或其中的 `code`）粘贴回 Magpie 提交；
   - **「通过 Refresh Token 登录（支持批量）」**：直接粘贴单个 `1//03...`、JSON 数组 `[{"refresh_token":"1//03..."}, ...]` 或任意含 Token 文本（兼容 Antigravity Tools / Antigravity-Manager 导出格式）。
2. 选择账号类型：**个人账号 (Personal)**（常规 Gmail 账号）或 **企业 / GCP (Vertex AI)**，按需填写代理地址（浏览器 OAuth 页面直连 Google；换取 Token 与后续请求走你配置的代理，也可通过 `ANTIGRAVITY_PROXY` 或插件选项 `antigravity.proxy` 设置）。
3. **提供匹配的 Google OAuth 客户端凭据**（仓库内零硬编码 `client_id` / `client_secret`），任选以下一种方式即可：
   - 在首次登录交互提示中直接填写（验证通过后按账号类型自动保存到 `~/.local/share/magpie-antigravity/oauth-clients.json`，后续免填）；
   - 设置环境变量 `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`（企业版可选 `ANTIGRAVITY_GCP_CLIENT_ID` / `ANTIGRAVITY_GCP_CLIENT_SECRET`，或使用 `ANTIGRAVITY_OAUTH_CLIENTS="antigravity_enterprise|id|secret"`）；
   - 运行命令行预置：`npm run antigravity:oauth -- --client-id <id> --client-secret <secret>`；
   - 或在 Refresh Token 方式粘贴 JSON 时附带 `client_id` 与 `client_secret` 字段。
4. 插件会自动换取短期 `access_token`、通过 `:loadCodeAssist` / `:onboardUser` 开通或绑定 `cloudaicompanionProject`、校验可用模型并将账号以 `0o700`/`0o600` 权限保存至本机 `~/.local/share/magpie-antigravity/accounts.json`（可通过 `ANTIGRAVITY_DATA_DIR` 修改）。

#### 核心特性与稳定性机制

- **协议线格式对齐与零凭据自动同步**：基于官方 `language_server` 实测抓包持续对齐 `tools` 打包、`requestId` / `trajectory_id` / `last_step_index`、`labels`、请求头顺序与 `accept-encoding: gzip`；GitHub Actions（`.github/workflows/antigravity-ua-sync.yml`）每日自动单遍流式提取官方成对版本号、CL 与公开协议信号并校验测试一致性，发现漂移时自动建 Issue 告警。运行期可从远端清单轻量热同步，也可通过 `npm run antigravity:sync-ua` 手动同步。
- **高命中率隐式前缀缓存**：基于会话首条消息与系统/工具指纹派生确定性 64 位 `sessionId` 粘性隔离不同会话与后台分类任务；提前剥离动态 `x-anthropic-billing-header`、清理 Schema `title` 噪音、按确定性预算收敛超大工具描述（`fitToolDeclarations`）并持久化 `thoughtSignature`（10,000 条 LRU + `signature-cache.json`）。
- **多账号轮转与精细限流分流**：支持多账号 `failoverOnError` 同请求故障转移；单模型池长冷却 `429` 自动转为 HTTP `400` 提示切换模型池，避免 Magpie 网关误锁整个账号（从而继续使用同号内仍有额度的 Gemini / Claude 池）。

#### Antigravity CLI 工具

```bash
npm run antigravity:status                                     # 查看数据目录、有效 Egress/OAuth UA、缓存与已保存账号
npm run antigravity:oauth -- --client-id <ID> --client-secret <SECRET>
npm run antigravity:oauth-login -- --proxy http://127.0.0.1:7890 # 打开浏览器完成 Google OAuth 授权（支持 --no-browser / --code）
npm run antigravity:login -- "1//03..." --proxy http://127.0.0.1:7890
npm run antigravity:models                                     # 查看聚合后的模型与思考变体列表
npm run antigravity:quota                                      # 查看实时 5h / 每周配额桶与模型余量
npm run antigravity:smoke -- --model gemini-3.8-flash-low      # 发送最小连通性测试请求
npm run antigravity:sync-ua                                    # 从官方归档流式提取最新成对 UA（支持 --remote / --local-only / --proxy）
npm run antigravity:sync-protocol                              # 零凭据本地/官方协议信号探测
```

---

### 方式二：Gemini Web (`gemini-web`)

1. 在 Magpie 中登录 **Gemini Web**，选择 **「一键配置本地 Gemini Web（推荐）」**，按提示填写代理地址（如 `http://127.0.0.1:7890`，无需代理可留空）及 **Google 账号索引**（`/u/N/app` 中的 `N`，单账号留空为 `0`）。
2. 在浏览器**无痕 / 隐私窗口**（推荐 Firefox）登录 <https://gemini.google.com/app>：
   1. 按 `F12`（macOS 按 `⌥⌘I`）切到 **Network（网络）**，刷新页面；
   2. 点击任意 `gemini.google.com` 请求 → **Headers** → **Request Headers**，复制 `cookie` 的完整值并粘贴回 Magpie；
   3. **直接关闭无痕窗口，不要点退出登录**（点退出会使会话失效）。
3. 若需回退官方上游 `gemini-web2api-go` 发行版或自行编译优化版后端，可执行：
   ```bash
   npm run backend:install:upstream  # 下载并校验官方 v4.31.0 二进制
   npm run backend:build:argon       # 或从源码构建优化版后端（详见 docs/backend-release.md）
   npm run backend:status            # 查看本地后端状态
   ```
   也可直接选择 **「连接已有后端（自定义地址 + API key）」** 接入自行托管的 `gemini-web2api-go` 服务。

> **为什么必须用无痕窗口？** `gemini-web2api-go` 会定期轮换 Cookie 保活。若与日常浏览器共用同一会话，Google 会将其判定为异常会话并踢出所有已登录 Google 服务。

---

## 配置与进阶

<details>
<summary><b>⚙️ Antigravity 插件选项与环境变量</b>（全部 28 项 `antigravity.*` 配置）</summary>

<br>

可通过 `magpie plugin options magpie-antigravity '{"antigravity":{...}}'` 或环境变量配置：

| 插件选项 (`antigravity.*`) | 对应环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `proxy` | `ANTIGRAVITY_PROXY` | `""` | 访问 Google 的 HTTP/HTTPS 代理（容器内用 `http://host.docker.internal:<port>`） |
| `dataDir` | `ANTIGRAVITY_DATA_DIR` | `~/.local/share/magpie-antigravity` | 存储 `accounts.json`、`oauth-clients.json`、`signature-cache.json`、`hub-version.json` |
| `uaManifestUrl` | `ANTIGRAVITY_UA_MANIFEST_URL` | `https://raw.githubusercontent.com/P4rfa1t/magpie-Antigravity/main/lib/antigravity-ua.json` | 远端成对 UA 清单地址；设为 `off`/`false`/`0` 关闭运行期热同步 |
| `detectLocal` | `ANTIGRAVITY_DETECT_LOCAL` | `false` | 设为 `true`/`1` 时在运行期扫描本机 Antigravity 客户端探测成对 UA |
| `clientId` / `clientSecret` | `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` | — | Personal Google OAuth 客户端凭据 |
| `gcpClientId` / `gcpClientSecret` | `ANTIGRAVITY_GCP_CLIENT_ID` / `ANTIGRAVITY_GCP_CLIENT_SECRET` | — | Enterprise / GCP OAuth 客户端凭据 |
| `allowTools` / `allowImages` / `imageModels` | — | `true` | 是否允许工具调用、图片输入与图像模型展示 |
| `contextLimit` / `outputLimit` | — | 上游模型真实上限 | 限制向客户端声明的最大上下文 / 输出 token |
| `requestTimeoutMs` / `modelTimeoutMs` | — | `570000` / `15000` | 单次生成超时（毫秒）与模型列表拉取超时 |
| `compactPrompt` | `ANTIGRAVITY_COMPACT_PROMPT` | `false` | 开启后额外剥离代码块外 `<example>` 段落并收紧默认工具预算至 `12000` |
| `toolTokenBudget` | `ANTIGRAVITY_TOOL_TOKEN_BUDGET` | `18000`（紧凑模式 `12000`） | 工具 Schema 描述 token 预算上限；设为 `0` / `off` 关闭裁剪 |
| `failoverOnError` | `ANTIGRAVITY_FAILOVER` | `true` | 单账号报错（`429`/`503`/`403`/`401`）时是否同请求轮换至下一可用账号 |
| `emptyReplyMaxWaitMs` / `emptyReplyRetryDelayMs` | `ANTIGRAVITY_EMPTY_REPLY_MAX_WAIT_MS` / `ANTIGRAVITY_EMPTY_REPLY_RETRY_DELAY_MS` | `0` / `1500` | HTTP 200 空候选重连时间上限（`0` 关闭，建议按需设为 `15000`）与退避延迟 |
| `streamIdleTimeoutMs` | `ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS` | `0` | 流式 SSE 分片间最大空闲超时（`0` 关闭，超时返回 `504`） |
| `signatureRectifier` | `ANTIGRAVITY_SIGNATURE_RECTIFIER` | `true` | 遇到损坏或缺失的 `thoughtSignature` 报错时自动剥离签名重试一次 |
| `silenceBoundary` | `ANTIGRAVITY_SILENCE_BOUNDARY` | `false` | 是否在 `systemInstruction` 注入静默身份边界声明 |
| `userProjectHeader` | `ANTIGRAVITY_USER_PROJECT_HEADER` | `auto` | `x-goog-user-project` 请求头策略（`auto` / `always` / `never`） |
| `claudeBetaHeader` | `ANTIGRAVITY_CLAUDE_BETA_HEADER` | `""` | 附加给 Claude 模型的 `anthropic-beta` 透传值 |
| `allowOverages` | `ANTIGRAVITY_OVERAGES` | `false` | 允许在限额后尝试 Google AI Credits 超额计费（`x-antigravity-allow-overages`） |
| `sandboxFallback` | `ANTIGRAVITY_SANDBOX_FALLBACK` | `false` | 主端点异常时是否允许回退探测 `sandbox.googleapis.com` |
| `autoPrivacy` | `ANTIGRAVITY_AUTO_PRIVACY` | `false` | 登录校验时是否自动调用 `:setUserSettings({})` 与 `:fetchUserInfo` |

</details>

<details>
<summary><b>🌐 Gemini Web 插件选项与本地后端管理</b></summary>

<br>

| 插件选项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `allowTools` | `true` | 允许工具调用；设为 `false` 时带工具请求返回 `400` |
| `allowImages` | `true` | 允许对话图片输入（需登录态 Cookie） |
| `requestTimeoutMs` / `modelTimeoutMs` | `570000` / `10000` | 单次等待后端 / 拉取模型列表超时（毫秒） |
| `stripCitations` | `true` | 自动剥离回复与工具参数中的 `[cite: 1]`、`[cite_start]` 引用标记 |
| `proxy` | 无 | 一键配置后端代理（也可用 `GEMINI_WEB_PROXY` 环境变量或登录第一步填写） |
| `baseURL` | `http://127.0.0.1:8083/v1` | Gemini Web 后端默认地址 |
| `contextLimit` / `outputLimit` | `1000000` / `8192` | 向客户端声明的上下文 / 输出上限 |

> **Windows PowerShell 设置选项提示**：`magpie` 命令行包装器（`magpie.cmd`）在转发参数时会丢失 JSON 中的双引号。请直接调用同目录的底层可执行文件（可通过 `where.exe magpie` 查看）：PowerShell 7.3+ 使用 `'{"allowImages":true}'`，Windows PowerShell 5.1 使用 `'{\"allowImages\":true}'`。

</details>

<details>
<summary><b>🐳 Docker / 远程服务器部署指南</b></summary>

<br>

1. **推荐优先使用 Antigravity**：纯无头 OAuth Refresh Token 认证，不依赖本地浏览器、`127.0.0.1` 页面或外部二进制，天然适配无桌面容器与远程服务器。
2. **容器内的代理地址**：bridge 网络中 `127.0.0.1` 指向容器自身而非宿主机。macOS / Windows Docker Desktop 请填 `http://host.docker.internal:<端口>`；Linux Docker 请附加 `--add-host=host.docker.internal:host-gateway` 或使用 `--network host`。
3. **持久化与僵尸进程清理**：挂载卷并固定 `ANTIGRAVITY_DATA_DIR` 与 `GEMINI_WEB_DATA_DIR`；如运行 `gemini-web` 且 Magpie 作为容器 PID 1 启动，建议启用 Docker `--init`（Compose 设 `init: true`），插件内置 `lib/proc.mjs` 的 `Z`/`X` 僵尸进程识别也会自动兜底。

</details>

<details>
<summary><b>🔒 安全、数据目录与卸载清理</b></summary>

<br>

- **Antigravity 数据目录**：`~/.local/share/magpie-antigravity`（可通过 `ANTIGRAVITY_DATA_DIR` 覆盖），以 `0o700` 目录 / `0o600` 文件权限保存 `accounts.json`、`oauth-clients.json`、`signature-cache.json`、`hub-version.json`。
- **Gemini Web 数据目录**：`~/.local/share/magpie-gemini-web`（可通过 `GEMINI_WEB_DATA_DIR` 覆盖），后端仅监听 `127.0.0.1`，日志文件为 `backend.log`。
- **卸载自动清理**：在 Magpie 中删除插件（或执行 `npm run backend:clean`）时，后台清理守护进程会自动停止托管的 `gemini-web2api-go` 并删除 `bin/` 下载产物，同时保留 `gemini.db`、`config.json` 与 `secrets.json` 以便重装复用。

</details>

---

## 友链

[LINUX DO](https://linux.do/) — 真诚、友善、团结、专业的技术社区。

## 许可证

MIT（见 [LICENSE](LICENSE)）。上游 `gemini-web2api-go` 同为 MIT（见 [LICENSE-UPSTREAM](LICENSE-UPSTREAM)）。

---

## Star 趋势

<p align="center">
  <a href="https://www.star-history.com/#P4rfa1t/magpie-Antigravity&amp;Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=P4rfa1t/magpie-Antigravity&amp;type=Date&amp;theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=P4rfa1t/magpie-Antigravity&amp;type=Date" />
      <img alt="magpie-Antigravity 的 GitHub Star 增长趋势" src="https://api.star-history.com/svg?repos=P4rfa1t/magpie-Antigravity&amp;type=Date" width="800" />
    </picture>
  </a>
</p>
