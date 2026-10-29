# 更新记录

## 0.2.1

- 修复 Codex 压缩时重放 `store: false` 的 `rs_…` reasoning id 被 JoyCode Responses 后端拒绝并连续失败的问题。转发前移除 reasoning item 的持久化 id，保留其摘要和加密内容；`store: true` 及其他 item 的 id 不变。

## 0.2.0

- 按 JoyCode 模型目录中的 `extJson.adapterType` 自动选择 Chat Completions、Responses 或 Anthropic Messages，使 `/models` 返回的 GPT、Claude 及其他模型都能使用正确的 SDK 和网关。
- 请求转发支持 `Request` 输入，并正确清理宿主生成的鉴权头及长度/主机头。
- Anthropic `/messages/count_tokens` 在插件本地返回 404，避免被转发为一次付费生成；三种协议统一携带 `language`。
- 修复 Anthropic Messages 与 Responses 的正常非流式 JSON 被误判为无效响应的问题；`flatten` 仅用于 Chat Completions。
- 增量还原 JoyCode 多包一层的 Anthropic 和 Responses SSE，使官方 Anthropic SDK、OpenAI SDK 及 Claude Code 能消费流式事件，同时保持标准 SSE 和跨 chunk 边界不变。

验证：42 项回归测试通过；真实 JoyCode 账号的 `joycode_modelList` 返回 15 个模型，覆盖 10 个 chat、4 个 `openai-response` 和 1 个 `anthropic`。最终 `provider test` 中，`GPT-6 Astra` 的 Responses 请求返回 200（3.0 秒），`Claude-Opus-5-hq` 的 Anthropic Messages 请求返回 200（7.3 秒）。另经 magpie 网关用官方 OpenAI SDK 和官方 Anthropic SDK 各发一条真实流式短请求，均收到完整事件和文本 `OK`（分别为 2.9 秒、7.6 秒）。更早一次 Claude 冷启动曾耗时 34.7 秒；分段计时显示延迟发生在上游响应头，不是插件等待完整回复后才返回。

## 0.1.1

- 支持浏览器登录京东账号，自动接收并验证 JoyCode 票据，保存租户和登录类型。
- 接入 IDE 同款额度接口，展示套餐、已用/剩余积分及有效期文字。
- 按账号动态同步模型列表和积分消耗倍率，正确识别 0× 免费模型。
- 补齐聊天请求所需的真实账号元数据，修复已登录却无法回复的问题。
- 将 HTTP 200 流式响应中的裸 JSON 错误转换为明确错误，避免客户端空白等待；权限错误不再误判为登录过期。
- 保留多轮消息与工具调用，加入 JoyCode 图标并缩短本地插件目录名。

验证：25 项回归测试通过；JoyAI-Code-1.6 的真实流式回复、工具调用往返和 magpie provider test 通过；用户确认 Claude 桌面端可使用。

## 0.1.0

- 本地供应商插件原型：手动 ptKey 登录、静态模型列表、签名网关转发及可选纯文本压平模式。
