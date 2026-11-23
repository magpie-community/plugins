# @magpie-community/opencode-deeprelay-auth

把 [DeepRelay](https://deeprelay.ai) 订阅接进 [magpie](https://usemagpie.ai) 和 OpenCode（1.x 全量，2.x 只有模型和聊天）：一个 `deeprelay` 供应商，模型、用量和余额都来自 DeepRelay。

## 安装

```bash
magpie plugin add @magpie-community/opencode-deeprelay-auth
magpie plugin login deeprelay
magpie provider test deeprelay
magpie quota
```

key 在 [deeprelay.ai/cloud/api-keys](https://deeprelay.ai/cloud/api-keys) 创建，只显示一次。用量需要 `billing:read`（`standard` 和 `full_access` 自带）。

## 模型

从 `GET /v1/models` 实时读取，去掉 `deeprelay/` 前缀，所以 agent 里是 `deeprelay/deepseek-v4.1-flash`。套餐模型按 `coding_agent_rank` 排在前面。缓存 5 分钟。

套餐模型（`GET /v1/models` 里 `plan_covered: true`）：

| 模型 | 倍率 |
| --- | --- |
| `deeprelay/deepseek-v4.1-flash` | ×1 |
| `deeprelay/glm-5.3` | ×12 |
| `deeprelay/kimi-k3.1-pro` | ×30 |
| `deeprelay/glm-5.3-flash` | ×1.75 |

按量计费模型在目录里标 `· PAYG`，用 `magpie models` 或 `GET /v1/models` 看实时列表。倍率只对套餐模型生效，×1 不显示；按量计费不显示倍率。

倍率是每个 token 的套餐权重，不是一次请求的固定费用。`cost` 取目录读取时的峰谷价，实际按请求到达时计费。

## 用量

| 窗口 | |
| --- | --- |
| 月输入 / 月输出 | 加权 token，单位 M；续费时间在月输出 |
| 周输入 / 周输出 | 滚动 7 天 |
| 网络搜索（本月） | 套餐含的搜索次数，不参与路由；用完不影响账号，开了搜索溢出则按量计费 |
| 钱包调用（24 小时） | 有按量计费调用时出现，不参与路由 |

不显示「用量兜底」（`quota.max_usage_micro_cents`，防滥用上限，不是额度）；`deeprelay quota --short` 里可见。

余额 $0 时按量计费模型返回 402，插件原样透传。

## 说明

- **会话追踪。** magpie 的 session id 作为 `X-Client-Request-Id` 发给 DeepRelay，请求日志可按 `client_request_id` 过滤。
- **不做协议转换。** DeepRelay 是 OpenAI chat completions，magpie 网关负责转换；`reasoning_content` 由 AI SDK 解析，流式和非流式都不丢。
- **支持范围。** magpie 和 OpenCode 1.x 功能完整；OpenCode 2.x 只提供模型和聊天，没有用量和会话追踪。

## 开发

```bash
bun test
```
