[English](./README.en.md) | 简体中文

# Croli 独立版 (`magpie-croli-independent`)

**零官方客户端进程 · 浏览器 OAuth · 每账号独立 P-256 设备签名 · 多账号隔离 · 原生工具调用。**

`magpie-croli-independent` 是面向 Magpie 的 Croli 网关独立接入插件（Provider ID：`croli-independent`，显示名：`Croli 独立版`）。它直接通过浏览器完成 Clerk OAuth，并在本机为每个账号生成独立的 P-256 设备密钥完成注册与网关请求签名，全程无需安装或启动 Croli 桌面端，也不与 `magpie-croli` 产生状态碰撞。

---

## 核心特性

- **零客户端接入**：通过浏览器完成 `clerk.croli.net` PKCE S256 OAuth + `127.0.0.1` 本地回调，自动注册设备并换取网关 Key；运行时不启动、不劫持、不读取 Croli 桌面客户端。
- **每账号独立 P-256 设备密钥**：为每个 `userId` 维护独立的 ECDSA P-256 密钥对，多账号并行调用不会触发同设备 `device_account_limit` 碰撞。
- **自动 403 设备补注册与时钟校准**：自动读取上游 `Date` 响应头校准签名时钟偏移；遇到设备未注册或签名失配导致的 403 时，单飞自动补注册并重试一次。
- **原生工具调用 + 可选 Schema 兼容开关**：默认零改写透传 `messages`、`system`、`tools` 与超长 MCP 工具名；提供默认关闭的 `tool-schema-compat` 开关，仅在遇到复杂 JSON Schema 报 400 时开启，且改写发生在 P-256 签名之前，确保签名覆盖实际传输字节。
- **一键与定时签到 + 每日首聊任务**：支持 Magpie 自动签到与真实对话完成后的每日首聊上报（SSE 完整结束或非流式确认 `choices` 后才上报，绝不伪造任务进度）。
- **独立设备管理 CLI**：内置零客户端命令行工具（`npm run devices`），支持查看与解绑已绑定设备；遇到 `account_device_limit` / `device_account_limit` 时返回明确中文提示且不泄露敏感信息。
- **透明的邀请来源优先级**：优先使用用户自己的首选账号或最新账号邀请缓存，其次使用用户手动预留码；仅当全新用户没有任何已登录账号且留空输入时，才会回落到默认社区邀请码（`YL39NEXRO3`），且随时可被手动输入或登录后自有账号覆盖。

---

## 安装与登录

通过 Magpie 直接从 GitHub 安装：

```bash
magpie plugin add github:Rick-Hlp/magpie-croli-independent
```

使用命令行或 Magpie 供应商卡片登录：

```bash
magpie plugin login croli-independent
```

提供三种接入方式：

1. **通过浏览器登录并自动绑定独立设备（零客户端）**：打开浏览器完成 Croli OAuth 授权，回调后自动生成并注册该账号专属的 P-256 设备密钥并换取网关 Key。
2. **使用邀请链接注册并通过浏览器绑定（零客户端）**：可选最新账号、指定账号或手动邀请码；新用户零账号留空时回落至默认社区邀请链接。
3. **Croli 网关 API Key**：直接粘贴 `csk_...`（纯 API Key 模式仅用于模型调用，不读取账户额度、签到与邀请）。

验证安装：

```bash
magpie plugin list
curl http://127.0.0.1:3425/v1/models
```

---

## 模型支持

仅展示账号 `GET /v1/models` 与已实测规格表的交集，过滤不可用变体：

| 发行商 | 模型 ID | 上下文 | 最大输出 | 文本 / 图片 |
|---|---|---:|---:|---|
| DeepSeek | `DeepSeek-V4.1-Flash` | 1,048,576 | 384,000 | ✓ / ✓ |
| OpenAI | `gpt-6-luna` / `gpt-6.1-sol` / `gpt-5.6-sol` / `gpt-5.6-luna` | 1,000,000–1,050,000 | 128,000 | ✓ / ✓ |
| Anthropic | `claude-opus-5.5` / `claude-sonnet-5` | 1,000,000 | 128,000 | ✓ / ✓ |
| xAI | `grok-4.6` | 500,000 | 450,000 | ✓ / ✓ |
| Google | `gemini-4-argon` | 1,048,576 | 65,536 | ✓ / ✗（仅声明文本） |

所有模型均声明 `low / medium / high` 思考档与 `toolcall: true`；试用额度耗尽后可能消耗积分，因此不会误标为永久免费。

---

## 插件选项

| 选项键 | 默认值 | 说明 |
|---|---|---|
| `stream-usage` | `true` | 流式请求附加 `include_usage`，不改写消息或系统提示词 |
| `auto-checkin` | `true` | 每日自动签到并在真实对话完成后上报每日首聊 |
| `invite_preferred` | `true` | 登录注册时按首选/指定账号/手动邀请码选择邀请源并记住选择 |
| `tool-schema-compat` | `false` | 默认关闭；仅在复杂 JSON Schema 导致上游报 400 时开启兼容改写与超长工具名截断 |

---

## 设备管理 CLI

当账号触发 `account_device_limit`（达到设备绑定上限）时，可使用内置零客户端工具列出或解绑旧设备：

```bash
# 查看当前账号已绑定的设备列表
npm run devices -- list

# 解绑指定设备
npm run devices -- remove <deviceId>
```

CLI 通过浏览器 OAuth 完成授权，仅输出设备 ID 与安全元数据，绝不打印 JWT、`refresh_token` 或私钥。

---

## 隐私与安全

- **零凭据泄露**：`ProtocolError`、日志、邀请缓存与 CLI 输出均严禁包含 JWT、`refresh_token`、API Key、私钥、请求头或上游自由文本响应体；仅提取符合安全 slug 形状的错误码（如 `account_device_limit`）。
- **最小权限本地密钥**：独立 P-256 设备私钥保存在 `~/.config/magpie/croli-independent-device.json`，以 `0600` 权限临时文件原子写入，目录权限 `0700`。
- **严格 HTTPS 源白名单**：协议层仅放行 `https://clerk.croli.net`、`https://api.croli.net`、`https://ds.croli.net`，强制 `redirect: "error"` 与有界响应体读取。
- **提示词零注入**：不注入 Croli 官方客户端系统提示词，不篡改调用方的 `messages`、`system` 或 `tools`（除非显式开启 `tool-schema-compat`）。

---

## 上游致谢与许可

- 本项目派生并独立重写自 [`MYCF711/magpie-croli`](https://github.com/MYCF711/magpie-croli)（MIT）与 [`MYCF711/magpie-plugin-scaffold`](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT），完整归属见 [`NOTICE.md`](./NOTICE.md)。
- 更新记录见 [`CHANGELOG.md`](./CHANGELOG.md)，实现与协议细节见 [`docs/internals.md`](./docs/internals.md)。
- 以 MIT 许可发布，详见 [`LICENSE`](./LICENSE)。
