# 更新记录

## 0.2.7

- Responses SSE 不再把空完成当成功：空 `response.completed` 转成 `empty_response`，缺少终止事件的 EOF 转成 `incomplete_response`，流内 JoyCode `FAILED_RESPONSE` 错误保留原始字段并转成标准错误事件。按事件增量处理，不缓存整段回复。
- 实际 magpie 0.1.2392 隔离验证：原版原协议透传接受空完成；修复后明确失败，随后上游恢复时可重试成功。真实短工具结果续答在本机 magpie 通道 2.96 秒返回 `OK`。历史静默结束没有保留原始 SSE，不能证明全部历史触发原因。

## 0.2.6

- 将真实验证通过的 GPT-6.1 Sol 和 GLM-5.3 加入长上下文白名单，最高采用 900k；仍要求账号目录声明更大的 Desktop 窗口，输出上限不变。
- 2026-11-04 经 magpie Responses 实测：900,064 输入 Token、25 输出 Token，15.95 秒正常完成并返回三个正确标记；约 1,000k 输入填充加指令被拒绝为 `context_length_exceeded`。GLM-5.3 经 Chat Completions 实测 900,074 输入 Token、64 输出 Token，98.31 秒正常结束并返回全部标记；1,000k 档返回 `Prompt exceeds max length`。GLM 的 jcloud / agent 别名保持不变，原 Codex 会话压缩未重跑。

## 0.2.5

- 对账号目录声明长窗口且真实请求成功的 GPT-6 Astra 和 DeepSeek-V4.1-Flash，分别采用最高 900k / 1,000k 的保守上下文声明；按 100k 向下取整，输出上限不变。未知模型和静态回退不变。
- 验证：Astra 实际输入 921,497 Token、DeepSeek 实际输入 1,000,073 Token 均正常结束并找回三个标记。Claude 900k 请求返回拒绝，未作为通过证据，暂不提高。未重跑原 Codex 长会话压缩。

## 0.2.4

- 从额度接口的有效期文字解析套餐到期时间。账号卡片悬停用量时显示「N 积分 将于 … 过期」（中国时区当天 23:59:59），并写入 magpie 的 `until`。套餐行优先，否则取最早的一份。不写成「重置于」，也不当成额度窗口的重置时间。
- 网关返回 `AI_GRAY_ACCESS_DENIED` 时丢弃缓存的账号身份，重新拉取一次并重发该请求。第二次仍被拒绝则返回 403，不把账号标成登录失效。其它 403 不重试。
- 模型目录成功但为空时保留内置模型。内置模型不再声明未验收的图片输入。非流式 JSON 读到结束再解析，超过 8MB 返回 `response_too_large`。

这次没有抓到新的网关原文。灰度重试只由 mock 覆盖，没有对 JoyCode 再做一次真实请求。

## 0.2.2

- 根据真实网关支持值修复 Codex 压缩的推理强度：GPT-6 Astra、GPT-6.1 Sol 的 `none` / `minimal` 转为 `low`；GPT-6 Sol、GPT-5.6 Sol 的 `minimal` 转为 `low`，保留这两个模型支持的 `none`。其他模型、协议、有效强度和未指定强度不变。
- 2026-10-30 对账号目录的全部四个 Responses 模型逐一发送 `none` 和 `minimal` 共八次真实请求：两个 Sol 的 `none` 返回 `OK`；其余六个组合明确返回 `unsupported_value`，参数为 `reasoning.effort`，支持值均包含 `low`。不依据 Codex 模型目录推断 JoyCode 后端能力。

修补后八个组合再次通过插件进行真实流式请求，全部返回 `OK` 和 `response.completed`（1.3–4.7 秒）。

验证范围为短请求和插件转发链路，尚未在原始长会话中重跑 Codex 压缩。

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
