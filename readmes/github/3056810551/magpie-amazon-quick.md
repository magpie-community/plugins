# magpie-amazon-quick

[中文](#中文说明) | [English](#english)

---

<a id="中文说明"></a>

面向 **Amazon Quick**（AWS Quick / QuickWork 桌面端，`Amazon Quick.exe`）的 OpenCode 与 Magpie Provider 插件。

兼容 **OpenCode 1.x**、**OpenCode 2.x** 及 **Magpie**，零外部 npm 依赖，并在 `package.json` 中内置了基于原版应用图标生成的 `magpie.icon` 图标。

## 功能特性

- **复用桌面端登录（只读）**：读取 `~/.quickwork/profiles.json` 及系统凭据库（`quickwork-<provider>-<id>`，支持 Windows 凭据管理器中的 UTF-16-LE 分片凭证及 macOS Keychain / Linux `secret-tool`），绝不覆盖或消耗桌面端自身的刷新令牌。
- **AWS IAM Identity Center OIDC PKCE 登录**：支持通过 `sso-oidc` `RegisterClient` + PKCE 与本地回环回调（`http://127.0.0.1:<port>/callback`）在浏览器完成授权。
- **从 JSON 文件导入**：支持在 Magpie 中从导出的 Amazon Quick 凭证 JSON 文件导入账号。
- **SNCS WebSocket 对话桥接**：将 OpenAI 兼容的 `/chat/completions` 请求（支持流式 SSE 与非流式 JSON、`reasoning_effort` / `thinking_delta` → `reasoning_content` 输出）适配到 Amazon Quick 的 SpaceNeedleConversationService（`SNCS`）双向 WebSocket（同时兼容 `AIDP` 与 `Gateway` 传输模式），并提供 `https://quick.aws.com/v1` / 账号 `tenantUrl` 基准地址支持。
- **联网搜索与客户端工具调用**：
  - 默认开启 `web_search_enabled: true`（与桌面端一致，也可通过请求体 `web_search_enabled: false` 关闭），并处理服务端工具流事件（`tool_start` / `tool_result` 等）。
  - 将客户端 `system` 指令与 OpenAI `tools` 定义通过 `<instructions>` 注入消息开头，并在消息末尾追加 `<client_tool_directive>` 强约束以屏蔽 Quick 云端沙箱写文件行为；将 `role: "tool"` 格式化为 `<tool_result>`，解析跨分片 `<tool_call>`（兼容可选 JSON 代码块围栏）以及 Anthropic 原生 `<function_calls><invoke><parameter>` XML 工具调用并按 Schema 还原参数类型，同时默认不发送伪造的 `outpostId`，确保 Zed / Magpie / OpenCode 的读写与终端工具可靠触发（使用写入/终端能力时，请确认客户端已启用 Write/Edit/Terminal 工具而非仅只读模式）。
- **有状态线程增量续传（1M 上下文）与 64 KB 帧压缩 / 云端附件兜底**：
  - 按「账号 + 会话 ID / 首轮消息前缀哈希 + 工具集合摘要」缓存并复用服务端 `thread_id`（`session_connect` 携带 `session_id` 与 `focus_only: true`），在连续多轮工具调用与对话中**仅增量发送新增的 `User` / `<tool_result>`**；当 IDE 动态系统上下文（打开文件、光标、诊断信息等）变化时自动发送轻量 `<system_context_update>` 增量段，同时保持线程连续性与 1M 上下文记忆。
  - 若发生切号、编辑或回退历史，或缓存线程已在服务端失效，自动无缝回退到新建 `thread_id` 与全量重传。
  - 对单次请求始终按 `AIDP` Base64 出站帧字节数（安全控制在 58 KB 以内，低于 AWS Quick 的 64 KB 单消息上限）自动分级压缩；遇到超长用户文本溢出或多模态 `image_url`（`data:` Base64 / `http(s):` URL），支持自动规范化 MIME 类型并上传至 Quick 云端附件存储（兼容 `AIDP` 与 `Gateway` 路径 + DLP 安全扫描 + `files/upload` 注入），将 `prompt_context.txt` 或图片以 `attachments` 元数据随消息发送。若上游仍报大小超限则返回 HTTP `400` 避免无效重试。（如需纯无状态版可切换至 Git 分支 `v0.1.3`。）
- **长连接分片重组与稳定性强化**：
  - 支持入站 `_chunked_frame` 分片重组，避免超长响应跨多帧被截断；内置 WebSocket 建连（15s）与流式空闲（90s）超时保护并返回明确 HTTP `504`。
  - 桌面端凭证基于 `profiles.json` 文件 `mtime` 与 Token 过期时间（支持数字时间戳与 ISO-8601 字符串）智能缓存，避免每轮重复拉起系统凭据进程；Quick 账号配置（`settings`）按账号缓存 2 分钟；浏览器 OAuth 回调服务支持超时自动关闭，防止放弃登录时残留本地端口占用。
- **动态模型列表与用量查询**：通过 `api/ws-rpc`（`get_settings`）获取账号已启用的模型槽位，并通过 `profile/usage` 查询月度与会话配额窗口及重置时间。
- **CJK 思维链与工具实参语言对齐**：中文 / 日文 / 韩文工具会话自动在 `custom_prompt` 注入语言一致性约束，避免将日志、报错文案或检索词翻译成英文导致查找失败；亦可通过环境变量隐藏上游 `reasoning_content`。

## 安装方式（Magpie）

在 Magpie 的 **Plugins** 页面直接填入 GitHub 仓库地址安装，或在 `Discover → Unofficial` 中搜索 `magpie-amazon-quick`：

```text
https://github.com/3056810551/magpie-amazon-quick
```

## 登录方式

1. **Amazon Quick account (browser)** *（推荐，尤其在 macOS 上：一键浏览器授权，独立会话，不触碰系统钥匙串）*
   - 直接打开浏览器前往 AWS IAM Identity Center（支持 Google / Amazon / Builder ID 等登录），完成授权后自动回传独立的 `access_token` 与 `refresh_token`，不依赖桌面端保持运行（`tenantUrl` 会从本机 `~/.quickwork/profiles.json` 自动识别）。
2. **Amazon Quick desktop's sign-in** *（复用桌面端登录；Windows / Linux 开箱即用，macOS 会触发钥匙串授权）*
   - 自动复用当前桌面端已登录账号，不会改动磁盘或凭据库中的刷新令牌。
   - 若桌面端关闭期间访问令牌过期，只需打开一次 Amazon Quick 桌面端（或在桌面端重新登录），插件会在下次请求时自动读取更新后的令牌。
   - **macOS 注意**：Quick 桌面端写入 Keychain 的条目仅信任自身 ACL，首次通过 `security` 读取需输入登录密码并点击**「始终允许」**；当 Quick 桌面端刷新并重建条目后 ACL 会重置，可能需要再次授权。macOS 强烈推荐使用方式 1（网页登录）或方式 4（JSON 导入）以避免弹框。
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

> **Claude Code 上下文显示 27.2 万（272k）而非 1M 说明**：本插件默认声明 1M 上下文并兼容 `[1m]` 模型后缀；如果通过 Magpie 接入 Claude Code 后上下文上限仍显示 `27.2万`，是因为 Magpie 默认向 `~/.claude/settings.json` 写入了 `"autoCompactWindow": 272000`。将该字段改为 `1000000`（或删除后重载窗口并新开对话），或在 Claude Code 中运行 `/autocompact` 即可恢复 1M 显示；若重新在 Magpie 中应用配置被写回，可额外设置系统环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`。

## 用量与配额

插件通过 `profile/usage` 接口读取当前账号的订阅计划与配额窗口；在 **Free Trial**（免费试用，`QUICK_LITE_FREE_TRIAL`）计划下实测包含以下配额窗口：

| 配额窗口          | 说明     | 默认限额 |
| ----------------- | -------- | -------- |
| **Monthly usage** | 月度用量 | 600 积分 |
| **Session usage** | 会话用量 | 100 积分 |

若账号启用了月度超额额度（`overage_monthly`），也会一并在 Magpie 用量卡片中展示；具体限额、已用积分与重置时间（`resetsAt`）以账号实时返回为准。

## 环境变量

- `QUICKWORK_DIR` / `AWS_QUICK_DIR`：覆盖默认的 `~/.quickwork` 配置目录路径。
- `MAGPIE_QUICK_STRIP_REASONING_CONTENT`：设为 `1` / `true` / `yes` / `on` 时不向调用方下发上游 `reasoning_content`（等价于 `executeSncsChat` 的 `stripReasoning: true`，显式传参优先）。

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
- **SNCS WebSocket Bridge**: Adapts OpenAI-compatible `/chat/completions` (both streaming SSE and non-streaming JSON, including `reasoning_effort` / `thinking_delta` → `reasoning_content`) onto Amazon Quick's SpaceNeedleConversationService (`SNCS`) bidirectional WebSocket (`AIDP` and `Gateway` transports), backed by the account's `tenantUrl` or `https://quick.aws.com/v1` base URL.
- **Web Search & Client Tool Calling**:
  - Defaults `web_search_enabled` to `true` (matching the desktop app; override with `web_search_enabled: false`) and handles server-side tool stream events (`tool_start`, `tool_result`, etc.).
  - Places `system` instructions and OpenAI `tools` declarations inside `<instructions>`, appends a trailing `<client_tool_directive>` to prevent Quick's cloud sandbox from writing to `/workspace` instead of calling client tools, formats `tool` results as `<tool_result>`, and parses both chunked `<tool_call>` JSON blocks (including fenced JSON) and Anthropic `<function_calls><invoke><parameter>` XML calls with schema-aware type coercion while omitting fabricated `outpostId` values (make sure write/terminal tools are enabled in your client such as Zed/Magpie Write mode rather than read-only Ask mode).
- **Stateful Thread Continuation (1M Context), 64 KB Frame Fitting & Cloud Attachments**:
  - Tracks active `(account, session / message-prefix, tools digest)` threads and reuses Quick's server-side `thread_id` (`session_connect` with `session_id` + `focus_only: true`), sending **only the incremental `User` / `<tool_result>` delta** on matching follow-up turns; when dynamic IDE `system` context (open files, cursor, diagnostics) updates between turns, appends a compact `<system_context_update>` delta without breaking `thread_id` continuity.
  - Automatically isolates accounts and transparently falls back to a fresh `thread_id` whenever history is edited or a resumed server thread expires.
  - Measures the encoded `AIDP` Base64 outbound frame size (kept within 58 KB, safely below Amazon Quick's 64 KB limit) and progressively compacts verbose schemas, older turns, and oversized system text while preserving the latest turn and `<client_tool_directive>`, mapping upstream size-limit errors to HTTP `400`. Also supports multimodal `image_url` inputs (`data:` URLs and `http(s):` URLs) and oversized user-message spillover (`prompt_context.txt`) via Quick cloud attachment uploads (`AIDP` + `Gateway` presigned upload with normalized MIME types, DLP status polling, and `files/upload/{threadId}` delivery). (Branch `v0.1.3` preserves the earlier purely stateless release.)
- **Inbound Chunked Frames & Connection Hardening**:
  - Reassembles inbound `_chunked_frame` payloads across out-of-order chunks, guards WebSocket connects (`15s`) and response idle stalls (`90s`) with HTTP `504` timeouts, caches desktop credentials against `profiles.json` `mtime` + token expiry (supporting numeric epochs and ISO-8601 strings), caches account settings for 2 minutes, and auto-closes abandoned OAuth loopback listeners.
- **Dynamic Models & Usage**: Discovers active model slots from `api/ws-rpc` (`get_settings`) and reports monthly & session quota windows from `profile/usage`.
- **CJK Reasoning & Tool-Argument Alignment**: Automatically appends a language-consistency rule to `custom_prompt` for Chinese / Japanese / Korean tool sessions so log lines, filenames, and search queries stay verbatim rather than being translated into English; optionally strips upstream `reasoning_content` via environment variable.

## Installation (Magpie)

Install directly from GitHub in Magpie **Plugins**, or find `magpie-amazon-quick` under **Discover → Unofficial**:

```text
https://github.com/3056810551/magpie-amazon-quick
```

## Sign-In Methods

1. **Amazon Quick account (browser)** *(recommended, especially on macOS — one-click browser login, independent session, never touches OS Keychain)*
   - Opens your browser directly to AWS IAM Identity Center (supporting Google / Amazon / Builder ID sign-in) using `quicksight:read_write` PKCE and obtains an independent `access_token` + `refresh_token` without disturbing your desktop session (auto-detects `tenantUrl` from local `~/.quickwork/profiles.json`).
2. **Amazon Quick desktop's sign-in** *(reuses desktop session; seamless on Windows/Linux, prompts Keychain on macOS)*
   - Uses your already signed-in Amazon Quick Desktop account automatically without touching its refresh token on disk/keyring.
   - If the desktop token expires while Amazon Quick Desktop is closed, open Amazon Quick Desktop (or sign in again there) and retry — the plugin re-reads the updated token on the next request.
   - **macOS note**: Amazon Quick Desktop writes its Keychain item with an ACL trusting only the desktop app itself, so reading it via `/usr/bin/security` requires entering your macOS login password and clicking **Always Allow** (and may prompt again whenever Quick Desktop recreates the Keychain item on session refresh). On macOS, **browser sign-in** or **JSON import** is strongly recommended.
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

> **Claude Code showing `272k` instead of `1M` context**: This plugin declares a 1M context window and strips `[1m]` model suffixes automatically. If Claude Code via Magpie still displays a `272k` ceiling, Magpie writes `"autoCompactWindow": 272000` to `~/.claude/settings.json` by default. Change it to `1000000` (or remove it, then reload the window and start a new chat), or run `/autocompact` inside Claude Code; if Magpie re-writes it on re-apply, set the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`.

## Usage & Quotas

The plugin reads the current subscription plan and quota windows via `profile/usage`. Under the **Free Trial** (`QUICK_LITE_FREE_TRIAL`) plan, observed default quota windows are:

| Window            | Description   | Default Limit |
| ----------------- | ------------- | ------------- |
| **Monthly usage** | Monthly quota | 600 credits   |
| **Session usage** | Session quota | 100 credits   |

When monthly overage (`overage_monthly`) is enabled on an account, it is displayed as an additional window in Magpie; exact limits, consumed credits, and reset times (`resetsAt`) reflect the account's live `profile/usage` response.

## Environment Overrides

- `QUICKWORK_DIR` / `AWS_QUICK_DIR`: Override the default `~/.quickwork` profile directory path.
- `MAGPIE_QUICK_STRIP_REASONING_CONTENT`: Set to `1` / `true` / `yes` / `on` to withhold upstream `reasoning_content` from callers (equivalent to `stripReasoning: true` in `executeSncsChat`; explicit option takes precedence).

## Tests

```bash
node --test index.test.mjs
```

## License

MIT
