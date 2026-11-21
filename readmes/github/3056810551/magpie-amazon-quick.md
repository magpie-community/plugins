# opencode-amazon-quick-auth

[中文](#中文说明) | [English](#english)

---

<a id="中文说明"></a>

面向 **Amazon Quick**（AWS Quick / QuickWork 桌面端，`Amazon Quick.exe`）的 OpenCode 与 Magpie Provider 插件。

兼容 **OpenCode 1.x**、**OpenCode 2.x** 及 **Magpie**，零外部 npm 依赖，并在 `package.json` 中内置了基于原版应用图标生成的 `magpie.icon` 图标。

## 功能特性

- **复用桌面端登录（只读）**：读取 `~/.quickwork/profiles.json` 及系统凭据库（`quickwork-<provider>-<id>`，支持 Windows 凭据管理器中的 UTF-16-LE 分片凭证及 macOS Keychain / Linux `secret-tool`），绝不覆盖或消耗桌面端自身的刷新令牌。
- **AWS IAM Identity Center OIDC PKCE 登录**：支持通过 `sso-oidc` `RegisterClient` + PKCE 与本地回环回调（`http://127.0.0.1:<port>/callback`）在浏览器完成授权。
- **从 JSON 文件导入**：支持在 Magpie 中从导出的 Amazon Quick 凭证 JSON 文件导入账号。
- **SNCS WebSocket 对话桥接**：将 OpenAI 兼容的 `/chat/completions` 请求（支持流式 SSE 与非流式 JSON、`reasoning_effort` / `thinking_delta` → `reasoning_content` 输出，以及 OpenAI `tools` 协议注入与跨分片 `<tool_call>` 解析）适配到 Amazon Quick 的 SpaceNeedleConversationService（`SNCS`）双向 WebSocket（同时兼容 `AIDP` 与 `Gateway` 传输模式），并提供 `https://quick.aws.com/v1` / 账号 `tenantUrl` 基准地址支持。
- **动态模型列表与用量查询**：通过 `api/ws-rpc`（`get_settings`）获取账号已启用的模型槽位，并通过 `profile/usage` 查询月度与会话配额窗口及重置时间。

## 登录方式

1. **Amazon Quick desktop's sign-in** *（推荐：已在 Windows / macOS / Linux 安装并登录 Amazon Quick 桌面端时使用）*
   - 自动复用当前桌面端已登录账号，不会改动磁盘或凭据库中的刷新令牌。
   - 若桌面端关闭期间访问令牌过期，只需打开一次 Amazon Quick 桌面端（或在桌面端重新登录），插件会在下次请求时自动读取更新后的令牌。
2. **Amazon Quick account (browser)** *（网页端一键浏览器授权，独立会话）*
   - 直接打开浏览器前往 AWS IAM Identity Center（支持 Google / Amazon / Builder ID 等登录），完成授权后自动回传独立的 `access_token` 与 `refresh_token`，不依赖桌面端保持运行（`tenantUrl` 会从本机 `~/.quickwork/profiles.json` 自动识别）。
3. **Amazon Quick Enterprise / Custom OIDC (browser)**
   - 用于尚未在本地登录过桌面端或需要指定企业专属 `issuerUrl` / `tenantUrl` 的场景，手动填入后在浏览器完成 OIDC PKCE 登录。
4. **Import accounts from a file…**（Magpie）
   - 导入包含 Amazon Quick 凭证字段（如 `access_token`、`refresh_token`、`client_id`、`issuer_url`、`tenant_url`）的 JSON 文件。

## 可用模型

| 模型 ID    | 说明                                               | 思考强度（Thinking Efforts）          |
| ---------- | -------------------------------------------------- | ------------------------------------- |
| `auto`     | Amazon Quick 智能路由                              | `off`, `low`, `medium`, `high`, `max` |
| `fast`     | Amazon Quick Fast（Haiku 5.5）                     | `off`                                 |
| `balanced` | Amazon Quick Balanced（Sonnet 5.5）                | `off`, `low`, `medium`, `high`, `max` |
| `smart`    | Amazon Quick Smart（Opus 5.5）                     | `off`, `low`, `medium`, `high`, `max` |
| `advanced` | Amazon Quick Advanced（深度推理，仅账号开启时显示） | `low`, `medium`, `high`, `max`        |

所有请求默认以 `incognito: true` 发送，不会在你的 Amazon Quick 桌面端历史会话列表中留下 API 对话记录。

## 用量与配额

插件通过 `profile/usage` 接口读取当前账号的订阅计划与配额窗口；在 **Free Trial**（免费试用，`QUICK_LITE_FREE_TRIAL`）计划下实测包含以下配额窗口：

| 配额窗口          | 说明     | 默认限额 |
| ----------------- | -------- | -------- |
| **Monthly usage** | 月度用量 | 600 积分 |
| **Session usage** | 会话用量 | 100 积分 |

若账号启用了月度超额额度（`overage_monthly`），也会一并在 Magpie 用量卡片中展示；具体限额、已用积分与重置时间（`resetsAt`）以账号实时返回为准。

## 环境变量

- `QUICKWORK_DIR` / `AWS_QUICK_DIR`：覆盖默认的 `~/.quickwork` 配置目录路径。

## 测试

```bash
node --test index.test.mjs
```

## 开源协议

MIT

---

<a id="english"></a>

OpenCode & Magpie provider plugin for **Amazon Quick** (AWS Quick / QuickWork desktop, `Amazon Quick.exe`).

Works with **OpenCode 1.x**, **OpenCode 2.x**, and **Magpie** with zero external npm dependencies, and bundles the original application icon via `magpie.icon` in `package.json`.

## Features

- **Amazon Quick desktop's sign-in**: Reads `~/.quickwork/profiles.json` and the OS credential store (`quickwork-<provider>-<id>`, including chunked UTF-16-LE blobs in Windows Credential Manager and macOS Keychain / Linux `secret-tool`) read-only — never overwrites or invalidates the desktop app's own session.
- **AWS IAM Identity Center OIDC PKCE**: Browser-based sign-in via `sso-oidc` `RegisterClient` + PKCE + loopback redirect (`http://127.0.0.1:<port>/callback`).
- **Import from JSON**: Supports importing exported Amazon Quick credential JSON files.
- **SNCS WebSocket Bridge**: Adapts OpenAI-compatible `/chat/completions` (both streaming SSE and non-streaming JSON, including `reasoning_effort` / `thinking_delta` → `reasoning_content` and OpenAI `tools` → `<tool_call>` translation) onto Amazon Quick's SpaceNeedleConversationService (`SNCS`) bidirectional WebSocket (`AIDP` and `Gateway` transports), backed by the account's `tenantUrl` or `https://quick.aws.com/v1` base URL.
- **Dynamic Models & Usage**: Discovers active model slots from `api/ws-rpc` (`get_settings`) and reports monthly & session quota windows from `profile/usage`.

## Sign-In Methods

1. **Amazon Quick desktop's sign-in** *(recommended on Windows/macOS/Linux where Amazon Quick Desktop is installed)*
   - Uses your already signed-in Amazon Quick Desktop account automatically without touching its refresh token on disk/keyring.
   - If the desktop token expires while Amazon Quick Desktop is closed, open Amazon Quick Desktop (or sign in again there) and retry — the plugin re-reads the updated token on the next request.
2. **Amazon Quick account (browser)** *(one-click browser login, independent session)*
   - Opens your browser directly to AWS IAM Identity Center (supporting Google / Amazon / Builder ID sign-in) using `quicksight:read_write` PKCE and obtains an independent `access_token` + `refresh_token` without disturbing your desktop session (auto-detects `tenantUrl` from local `~/.quickwork/profiles.json`).
3. **Amazon Quick Enterprise / Custom OIDC (browser)**
   - Prompts for custom/enterprise `issuerUrl` and `tenantUrl` before opening browser OIDC PKCE sign-in.
4. **Import accounts from a file…** (Magpie)
   - Import a JSON file containing Amazon Quick credential fields (`access_token`, `refresh_token`, `client_id`, `issuer_url`, `tenant_url`).

## Available Models

| Model ID   | Description                                                              | Thinking Efforts                      |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `auto`     | Amazon Quick Auto-Routing                                                | `off`, `low`, `medium`, `high`, `max` |
| `fast`     | Amazon Quick Fast (Haiku 5.5)                                            | `off`                                 |
| `balanced` | Amazon Quick Balanced (Sonnet 5.5)                                       | `off`, `low`, `medium`, `high`, `max` |
| `smart`    | Amazon Quick Smart (Opus 5.5)                                            | `off`, `low`, `medium`, `high`, `max` |
| `advanced` | Amazon Quick Advanced (Deep Reasoning, when enabled in account settings) | `low`, `medium`, `high`, `max`        |

All model requests run with `incognito: true` so API turns do not clutter your Amazon Quick Desktop sidebar history.

## Usage & Quotas

The plugin reads the current subscription plan and quota windows via `profile/usage`. Under the **Free Trial** (`QUICK_LITE_FREE_TRIAL`) plan, observed default quota windows are:

| Window            | Description   | Default Limit |
| ----------------- | ------------- | ------------- |
| **Monthly usage** | Monthly quota | 600 credits   |
| **Session usage** | Session quota | 100 credits   |

When monthly overage (`overage_monthly`) is enabled on an account, it is displayed as an additional window in Magpie; exact limits, consumed credits, and reset times (`resetsAt`) reflect the account's live `profile/usage` response.

## Environment Overrides

- `QUICKWORK_DIR` / `AWS_QUICK_DIR`: Override the default `~/.quickwork` profile directory path.

## Tests

```bash
node --test index.test.mjs
```

## License

MIT
