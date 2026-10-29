# JoyCode

把京东云 **JoyCode**（JoyCoder IDE 自带的模型额度）作为一个多协议供应商接进 [magpie](https://usemagpie.ai)。装好后，所有 agent（Claude Code、Codex 等）都能通过 magpie 用 `joycode/<model>` 访问 JoyCode 的模型，并享受 magpie 的多账号号池、故障切换和用量统计。

逆向了 JoyCode IDE 的「彩网关」协议（`https://api-ai.jd.com/api`，HMAC-SHA256 签名 query + `ptKey` 账号票据头）。请求与 IDE 本身走同一账号、同一额度。

## 安装

```bash
magpie plugin add @magpie-community/opencode-joycode-auth
```

```bash
magpie plugin login joycode
```

两种登录方式（任选）：

1. **浏览器登录（京东账号）**（推荐）— magpie 打开 JoyCode 官方登录页，用京东账号/扫码登录，完成后自动拿到凭证。和 JoyCode IDE 自己的登录走的是同一套流程。
2. **手动粘贴 ptKey** — 从已登录的 JoyCode IDE 登录态里提取（`%APPDATA%\JoyCode\User\globalStorage\state.vscdb` 的 `JoyCoder.IDE` → `joyCoderUser.ptKey`）。这是**账号票据**，等同密码，勿外传。这种方式还会追问可选的 tenant（企业租户名，个人账号留空）。

凭证由 magpie 存在自己的 `plugin-auth.json`（权限 600），本插件目录里不落任何凭证。

多账号 = 多次登录：`magpie plugin login joycode` 再跑一遍（或在应用里再点一次），每个账号是一个号池座位，magpie 会自动轮换。

## 模型

模型由登录账号的 `joycode_modelList` 动态同步，不需要在插件里逐个维护。插件读取每个模型的 `extJson.adapterType`，为它选择对应的协议、AI SDK 和 JoyCode 网关：

| `extJson.adapterType` | 上游协议 | AI SDK | JoyCode `functionId` |
|---|---|---|---|
| 缺失 / 其他 | OpenAI Chat Completions | `@ai-sdk/openai-compatible` | `chat_completions` |
| `openai-response` | OpenAI Responses | `@ai-sdk/openai` | `responses_completions` |
| `anthropic` | Anthropic Messages | `@ai-sdk/anthropic` | `anthropic_completions` |

因此 GPT 模型会走 Responses，Claude 模型会走 Anthropic Messages，GLM、Kimi、DeepSeek、MiniMax、Doubao 等继续走 Chat Completions。2026-10-28 使用真实账号核对时，`joycode_modelList` 返回 15 个模型：10 个 chat、4 个 `openai-response`、1 个 `anthropic`，三类均已覆盖。

同时通过 `plugin_config` 的 `billingRate` 场景同步积分消耗倍率。点击「重新获取模型」可更新模型和倍率；按 `chatApiModel` 匹配，不会把仅出现在计费表中的模型加入列表。模型自身的倍率优先；公共倍率配置遵守 `excludeTenants`，无租户或被排除的租户不套用公共倍率。明确的 0× 会标记免费；查不到的倍率不当作 0×，也不虚构优惠前倍率。

当前实测：JoyAI-Code-1.6 0×、GLM-5.3 0.6×、Kimi-K2.6 0.5×、MiniMax-M3 0.4×、Doubao-Seed-2.0-pro 0.4×。这些是查询结果，代码没有写死价格。它们是积分倍率，不是美元/token 价格。

**视觉（image_url）为实验性**：按接口 `features` 声明能力，实际图片请求尚未验收。

## 消息转发策略

默认保留完整多轮对话、工具调用和模型原生请求格式。插件从当前账号的 `joycode_userInfo` 获取真实 `userId`、`tenant`、`orgFullName`，按 JoyCode 请求格式补入正文；三种协议统一设置 `language: UNKNOWN`。身份信息按账号 loader 隔离缓存，不接受客户端指定的用户身份。缺少这些元数据时，已观察到网关返回 `AI_GRAY_ACCESS_DENIED`。

网关可能以 HTTP 200 和 SSE 响应头返回裸 JSON 错误；插件会把这种错误转换为明确的失败响应，避免客户端一直等待。普通 403 权限错误不会再被误标为登录失效。

JoyCode 的 Anthropic 与 Responses 网关还会给 SSE 多加一层 framing（Anthropic 为 `data: event: …` 和 `data: data: …`，Responses 为 `data: data: …`）。插件在流式转发时增量还原标准 SSE，不缓存完整回复；否则官方 Anthropic/OpenAI SDK 会分别表现为空流和 `malformed server-sent event JSON`。标准 SSE 会按原字节透传，跨上游 chunk 的边界也有回归测试。

Codex 在 `store: false` 下仍可能重放带 `rs_…` id 的 reasoning item。JoyCode 的 Responses 后端会把这些 id 当成已持久化条目查找，找不到便以 `Item with id 'rs_…' not found` 拒绝整个请求，压缩尤其容易触发。插件在转发前移除这类 reasoning item 的 `id`，保留其 `summary` 和 `encrypted_content`；`store: true` 时保留 id，其他 item 的 id 也不改。

0.1.1 已实测 JoyAI-Code-1.6 完整流式文字回复、工具调用及工具结果往返，并通过 magpie `provider test`。0.2.0 于 2026-10-28 通过真实账号验证：`provider test` 的 `GPT-6 Astra` Responses 请求返回 200（3.0 秒），`Claude-Opus-5-hq` Anthropic Messages 请求返回 200（7.3 秒）；再经 magpie 网关用官方 OpenAI SDK 的 Responses 流和官方 Anthropic SDK 的 Messages 流各发一条短请求，均正确收到文本 `OK` 和完整事件序列（2.9 秒、7.6 秒）。更早的 Claude 冷启动曾出现 34.7 秒，分段计时显示时间耗在上游响应头而不是插件缓冲。Anthropic 的 `/v1/messages/count_tokens` 在插件本地返回 404，不访问 JoyCode，避免把 token 计数误发成一次付费生成。

如果实测 JoyCode 后端拒绝多轮/工具调用格式的消息，可以开启回退模式：

```bash
magpie plugin options joycode '{"flatten": true}'
```

flatten 模式会把 Chat Completions 消息压平成 `system + 单条 user prompt`（工具调用和工具结果会被丢弃），Responses 和 Anthropic Messages 不受影响。**开了 flatten 就别用 chat 模型跑需要工具的 agent 会话**，只适合纯对话。默认关闭。

## 已知限制

- **额度展示**：通过 IDE 同款 `get_newpoint_ide` 接口读取套餐、已用/总积分、剩余积分和有效期文字，可在账号及用量页面刷新。有效期文字不等同于额度重置时间，因此不推算重置倒计时。多个积分池分别显示，不相加；额度窗口仅作展示，由上游判定具体模型能否继续使用。
- **ptKey 失效**：表现为账号被标记「需要重新登录」，重新 `magpie plugin login joycode` 即可。
- **签名 key 轮换**：签名 key 是内嵌在每份 JoyCode IDE 里的公开协议常量，不是密钥。若 JoyCode 轮换它，从新版 `extension.js` 重新提取后，可通过环境变量 `JOYCODE_SIGN_KEY` 覆盖，无需改代码。
- 登录方式默认 `loginType: PIN_JD_CLOUD`；如果你的账号是京东云企业域登录且请求被拒，改 `index.mjs` 顶部的 `LOGIN_TYPE` 常量。

## 开发

```bash
bun test                # 浏览器登录、额度映射、模型倍率回归测试
```

相关文档：[magpie 插件开发](https://usemagpie.ai/docs/zh/plugins)。版本变更见 [CHANGELOG.md](CHANGELOG.md)。

这是非官方适配插件，与京东或 magpie 官方无隶属关系。JoyCode 图标及商标归其权利人所有；代码的 MIT 许可不授予这些品牌资产的权利。
