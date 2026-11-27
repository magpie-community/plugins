# magpie-mogick

OpenCode & Magpie provider plugin for **Mogick** (`mogick`).

## 登录方式

使用 OAuth 2.0 设备授权码流登录 Mogick（`https://login.tongyuan.cc/authentication/oauth2`）：

```bash
magpie plugin add ./magpie-mogick
magpie plugin login mogick
```

凭证由 Magpie 统一保存在配置目录的 `plugin-auth.json`（或 OpenCode 的 `auth.json`）中，并启用单次轮换令牌保护（`rotating: true`）及到期前 15 分钟单飞续期。

## 功能特性

- **动态模型清单**：从 `modelinfo` 免鉴权拉取支持模型、上下文限制与 `reasoning_efforts` 档位（10 分钟单飞缓存，拉取失败自动回退）。
- **协议双向改写**：
  - 出站注入 Mogick 链路追踪头（`X-Session-Id`、`X-Mogick-*`、`X-Chat-Id`、`Traceparent`）与 `5m` 会话 / `60s` 回合前缀缓存复用。
  - 工具名 `.` ↔ `__dot__` 双向编解码，以及 `tool` 消息 `name` 字段清理。
  - 流式 SSE 与非流式响应的模型名还原、分片 `tool_calls` 元数据回填、`_mogick_*` 参数剥离与 `reasoning_content` 剥离。
- **插件选项开关**（默认全部开启，可在 Magpie 提供商编辑页或 `magpie plugin options mogick` 中切换）：
  - `fold_reasoning_effort`：折叠 `minimal`/`medium`/`xhigh`/`ultra` 为 `low`/`high`/`max`
  - `strip_mogick_args`：剥离 `_mogick_*` 工具参数
  - `strip_reasoning`：剥离 `reasoning_content`
- **用量与签到**：
  - 支持 `auth.usage`（展示可用/套餐/赠送/冻结 credits 余额）与 Magpie 原生 `auth.checkin`（可在提供商编辑页「高级 → 每日签到」中开启）。
  - 在 OpenCode 等非 Magpie 宿主中（无 `auth.checkin`），默认仍会在每个账号每个 UTC 日首次对话前自动触发一次余额查询以结算每日登录奖励（可在插件选项中传入 `claim_daily_reward: false` 关闭）。
