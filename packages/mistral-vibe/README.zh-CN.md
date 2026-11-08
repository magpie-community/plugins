# Mistral Vibe

简体中文 | [English](README.md)

把 **Mistral Vibe** 的编程套餐接入 [magpie](https://usemagpie.ai) 与
[OpenCode](https://opencode.ai) 的供应商插件。**非官方**：与 Mistral AI 无隶属、
无背书、无支持关系。

一个供应商、一个模型组、两个钱包。Vibe key 登录后，模型来自 Vibe 套餐自己的
目录并追加 DeepSeek；每个模型都出现在 Vibe 钱包里，若同时提供 Studio key，还会
以 `<id>--api` 的形式出现在 API 钱包里。套餐每月的 Vibe Code 与 API 额度会显示
在 magpie 的用量卡片、`magpie quota`、额度提醒和 `GET /v1/magpie/quotas` 中。

**供应商 id：** `mistral-vibe`

| | |
|---|---|
| API | `https://api.mistral.ai/v1`（`@ai-sdk/openai-compatible`） |
| 登录 | 一条凭据装两把 key：`vibe=…;api=…`（只填 Vibe key 也可以） |
| 模型 | Vibe Code 目录（2026-11-08 为 4 个）加上 DeepSeek |
| 额度 | `GET /v1/billing/budget` → `vibe_budget`、`api_budget`、`reset_at` |

## 登录

```sh
magpie plugin login mistral-vibe
```

粘贴一行：

```
vibe=<Vibe key>;api=<Studio key>
```

- **Vibe key**：官方 CLI 执行 `vibe --setup` 后写入 `~/.vibe/.env` 的那把，
  或 chat.mistral.ai/code/extensions → **Vibe CLI** 卡片 → **Advanced** →
  **Vibe API Key**。它的请求先花套餐的 Vibe 额度。
- **Studio key**（可选）：console 的 **API › API keys**。它让同一批模型也出现在
  API 额度上。

只填 Vibe key 就能用 Vibe 钱包。两把 key 都不过期。也接受 JSON
（`{"vibe":"…","api":"…"}`）或两把裸 key 以 `;` 分隔。

这一行同时包含两把 key，等同于两个密码：不要贴到 issue、截图或日志里。

## 模型

2026-11-08 的 Vibe Code 目录有 4 个模型：

| id | 名称 | 上下文 | 思考档位 | 视觉 |
|---|---|---|---|---|
| `mistral-large-4-0` | Mistral Large 4 | 1M | low / medium / high | 是 |
| `mistral-medium-latest` | Mistral Medium 3.5 | 262k | none / high | 是 |
| `zai-glm-5-3` | GLM 5.3 (Mistral Hosted) | 1M | low / high / max | 否 |
| `zai-glm-5-3-flash` | GLM 5.3 Flash (Mistral Hosted) | 1M | low / high / max | 是 |

额外加入 DeepSeek：CLI 选择器里没有它，但实测 Vibe key 可以调用。两把 key 都在
时，每个模型出现两次，靠别名区分钱包：

| 模型 id | 显示名 | 花哪个 |
|---|---|---|
| `deepseek-v4-1-flash-1017` | `deepseek-v4-1-flash-1017 (Vibe budget)` | 先花套餐的 Vibe 额度，再按量付费 |
| `deepseek-v4-1-flash-1017--api` | `deepseek-v4-1-flash-1017 (API budget)` | API 额度 / 按量付费 |

`--api` 后缀在请求发出前去掉，fetch 用它挑 key。只有一把 key 时，只列出该钱包的 id。

2026-11-08 在 Education 套餐账号上实测（Vibe Code 额度 150 USD、API 额度
15 USD），同一个模型经 magpie 网关：

| 别名 | 请求 | `vibe_budget` | 扣在 Vibe 额度上 |
|---|---|---|---|
| `…--api` | 248 tokens，200 | 0.000784 % → 0.000784 % | **$0.000000** |
| 裸 id | 266 tokens，200 | 0.000784 % → 0.000986 % | **$0.000303** |

目录读不到时，退回账号的 `/v1/models` 并去重：只留对话模型
（`capabilities.completion_chat`），同一底层模型只留一个 id（上面的账号是
64 条 → 14 个）。归并依据 `billing_model_name` 与 `aliases` 互链；保留的 id
依次优先：billing 名、显示名与 id 相同的那个、`-latest`。老配置里用别名的请求
仍然可用。

### 在 magpie 里显示模型

magpie 只显示已勾选的模型，插件新增的 id 默认未勾选。勾一次即可——在应用里的
供应商页面，或：

```sh
magpie provider models mistral-vibe \
  +mistral-large-4-0 +mistral-large-4-0--api \
  +mistral-medium-latest +mistral-medium-latest--api \
  +zai-glm-5-3 +zai-glm-5-3--api \
  +zai-glm-5-3-flash +zai-glm-5-3-flash--api \
  +deepseek-v4-1-flash-1017 +deepseek-v4-1-flash-1017--api
```

## 额度

`auth.usage` 读取官方 CLI 用的三个公开接口：`/v1/billing/budget`（两个额度和
重置时间）、`/v1/billing/subscription`（套餐名）、
`console.mistral.ai/api/vibe/whoami`（key 的作用域）。两个窗口都会显示，key
自己的那个排在前面。key 被拒（401）会标记账号过期；额度接口 403 或套餐没有该
额度时会说明原因，而不是显示空卡片。

```sh
magpie quota mistral-vibe
```

## 请求与回复修正

均移植自 [mistral-gateway](https://github.com/Classic298/mistral-gateway)
（其作者实测得出）：

- 别名改写为 Mistral 实际提供的 id；
- `max_completion_tokens` → `max_tokens`、`seed` → `random_seed`、丢弃 `user`
  （Mistral 对这些返回 422）；
- 自动补 `max_tokens`（GLM 131072，其他 32768）：不补时 Mistral 把 GLM 输出
  限制在 4096，思考就可能耗尽；
- 客户端原样回传的消息里去掉 `reasoning_content` 和 `index`；
- GLM 的 tool 结果轮次若未指定档位，补 `reasoning_effort: "high"`，避免它
  无可见输出就结束；
- 流式请求缺少 `stream_options: {include_usage: true}` 时补上；
- 被拒的 `reasoning_effort` 会按模型支持的最接近档位重试一次（`/v1/responses`
  下是嵌套的 `reasoning.effort`）；
- 429 在同一把 key 上按 `Retry-After` 重试，窗口 60 秒；
- GLM 的类型化 content（`[{type:"thinking"…},{type:"text"…}]`）在流式与非流式
  下都换算为字符串 `content` 和 `reasoning_content`；已产生 tool_calls 却以
  `stop` 结束的流改为 `tool_calls`。

## 隐私

key 只保存在 magpie 自己的存储（`plugin-auth.json`，或 OpenCode 的
`auth.json`）里。插件不上报遥测、不读取其他文件；网络请求只有上面三个额度
接口，以及 magpie 为模型发出的请求。

## 免责声明

这是非官方社区项目，与 Mistral AI 无隶属、无背书、无支持关系。它使用官方
Mistral Vibe CLI 相同的凭据与接口；Mistral 的条款仍然适用，套餐额度限制照常
生效。Mistral 的消费者条款禁止共享账号或 key、禁止通过多账号绕过限制——请只在
自己的账号上使用。条款与接口可能随时变化，如何执行由 Mistral 决定。本软件按
"现状"提供，不附带任何担保；作者不对任何损失负责，包括账号被限制、key 被停用
或订阅费用损失。依赖前请自行核对最新条款。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 测试

```sh
bun test          # 本地模拟 Mistral 接口；不联网、不需要 key
```
