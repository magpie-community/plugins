# Gemini 网页版中继（gemini-relay）

把 Gemini 网页版（gemini.google.com）接进 OpenCode 和
[magpie](https://usemagpie.ai)：请求由一个**常驻的真实浏览器中继**代发——
裸的 Node 客户端在很多网络上会被 Google 以 `/sorry` 拒掉，而同一条请求从
Gemini 自己的页面里发出（用页面自己的 Cookie、自己的 TLS），就能被正常服务。
浏览器跨请求保活，每次对话只是页面内的一次 fetch，边读边流式返回。

> Unofficial, use at your own risk. This package is not affiliated with,
> authorized or endorsed by Google. "Gemini" is a trademark of Google, used
> here solely to identify the service. The plugin drives the same endpoints
> the Gemini web app itself uses, with your own signed-in browser profile;
> it does not bypass captchas, rate limits or any platform restriction.
> The protocol is not documented and may change or stop working at any time.

## 工作方式

两条传输路径，页内执行（页面自己的 Cookie、TLS、令牌）：

1. **WebChannel**（`webchannel.mjs`，`processSession`）——主路径。在页面里
   跑，服务端看到的是页面自己的会话上下文，模型档位由它决定。
2. **StreamGenerate**（`relay.mjs`，旧的 batchexecute）——回退路径。
   WebChannel 握手被拒、端点变更等传输级失败时使用。

模型档位由应用自己的 mode 字节路由（请求头 `x-goog-ext-525001261`）：
`1` 走免费档，`3` 走 Pro 档。**严格模式默认开**（`strict_model !== false`）：
要了 Pro 却被服务端静默降级成免费档时，直接报错而不是当作成功返回。

每次对话都是**临时会话**（inner[45] = 1，实测 2026-11-22）：不进账号的
历史记录。会话池（`session_pool.mjs`）让接续上一轮的请求复用服务端会话、
只发新消息——但临时会话无法续接（服务端回 400），所以池里的都是普通会话。

## 模型

| 模型 | mode 字节（b14） | 说明 |
|---|---|---|
| `gemini-auto` | 不带头 | Google 自己挑（访客可用） |
| `gemini-3.6-flash` | 1 | 4 Hydrogen（免费档） |
| `gemini-3.1-pro` | 3 | 4 Neon（Pro 档），思考深度走 `reasoning_effort` |

`gemini-3.1-pro`（4 Neon）带思考深度三档，用 OpenAI 的 `reasoning_effort`
传：`low` / `medium` / `high`（对应应用选择器的 低/中/高，协议字节 1/4/2）。
不传就用应用自己的默认档。

## 登录方式

本插件**独立登录**：有自己的浏览器配置根目录（`gemini-relay-browser`），
不依附、不复用任何其他插件的登录状态。

| 方式 | 做什么 | 给什么 |
|---|---|---|
| **在单独的浏览器窗口登录（推荐）** | 插件拉起独立 Chrome 窗口（本插件自己的配置，不碰日常浏览器），你登录 Google 账号，打开 Gemini 后窗口自动关闭 | 全部模型 |
| **不登录使用（访客）** | 用无登录的独立浏览器；网页版也回答访客 | 仅 `gemini-auto`（经由 Auto，多半是较轻的模型） |

**Profile 边界**：与 moss/quick 插件同规则——只用插件自己的专用 profile
（`%LOCALAPPDATA%/magpie/gemini-relay-browser`），绝不碰日常浏览器，
也不读写其他插件的目录。

## OpenAI 兼容接口

- `model`：上表之一（可带 `gemini-relay/` 前缀）
- `stream: true` → SSE：`reasoning_content` 先行、正文随后、`[DONE]` 结束；
  最后一个 finish 块带 usage（token 数按字符数 ÷3 估算，网页端不回报计数）
- `stream: false` → 聚合 JSON：正文在 `choices[0].message.content`，思考在
  `reasoning_content`（同时以 `reasoning` 字段给出，两种 SDK 读法都照顾）
- 历史：把全部 OpenAI messages 压平成一段文本（system 在前，工具调用与结果
  作为上下文内联）经临时会话发出
- `reasoning_effort`：`low`/`medium`/`high`，仅 4 Neon（`gemini-3.1-pro`）
  生效，对应应用选择器的思考深度三档
- `strict_model: false` 可关掉档位校验（不建议）

## 多账号池与风控调度（可选高级入口）

默认的单账号路径不变。要多账号轮转、把封号风险压到最低时，用 `wire.mjs`
的 `createAccountAwareRelay`（`@nonamelane/magpie-gemini-relay/pool`）：

```js
import { createAccountAwareRelay } from "./wire.mjs"

const relay = createAccountAwareRelay({
  accounts: [
    { id: "a1", profileDir: ".../gemini-relay-browser/xxxx", weight: 1 },
    { id: "a2", profileDir: ".../gemini-relay-browser/yyyy", weight: 2 },
  ],
  options: { headless: true }, // 另有 perAccountRpm=6 / globalRpm=20 / cooldownMs / banMs 等
})

const r = await relay.ask("你好", { model: "gemini-3.1-pro", reasoningEffort: "high" })
const usage = await relay.usage("a1") // 该账号的额度快照（60s 缓存，尽力而为）
const s = relay.stats()               // 账号池状态（ok/fail/冷却/封禁/在飞）
```

风控策略（`accounts.mjs`，全部离线可测）：

- **least_used 轮转**：成功+失败最少的账号优先，weight 高的多承担，
  最久未用的优先，同分随机抖动——避免流量集中在一个账号上。
- **并发闸**：每账号在飞请求默认 ≤2，满了自动换号。
- **限速**：每账号 6 rpm + 全局 20 rpm 令牌桶（`TokenBucket`），请求之间
  再加 300–1500ms 的拟人随机停顿（`Jitter.humanPause`），避免机器节奏。
- **失败分级记责**（`AccountPool.release`）：
  - `429` / `usage_limit_exceeded`(1037)：只冷却“账号×模型档位”15 分钟
    （额度按模型档位算，不牵连整号）；
  - `401` / `auth_corrupted` / `rotate_401`：连续失败 +1，满 3 次封禁 2 小时；
  - `ip_blocked`(1060)：出口 IP 的问题，不记账号头上，连续失败计数重置；
  - 其他失败：连续 3 次也封禁，避免带病账号反复撞风控。
- **熔断**（`CircuitBreaker`）：连续 5 次失败熔断 2 分钟，冷却后放一个
  探测请求，成功才闭合。
- 全部账号不可用时抛 `GeminiError`（status 429，code
  `all_accounts_exhausted`），message 里带最早解封时间。

用量与配额（`usage.mjs`）：在账号自己的页面里发 batchexecute（`jSf9Qc`
GET_USAGE_INFO + `qpEbW` CHECK_GEMINI_QUOTA），解出订阅档位（FREE/PRO/
ULTRA/PLUS）、5 小时窗口、周窗口、AI credits，以及 Pro/Flash/
FlashThinking 的 remaining/total/用量百分比/重置时间。失败不致命：返回
`{ error }` 并保留上一次快照（标 `stale`），聊天路径完全不受影响。

## 自检

```bash
bun test packages/gemini-relay   # 离线测试（假 ask，不碰网络）
bun scripts/check.mjs gemini-relay
node packages/gemini-relay/selftest.mjs   # 端到端，需要真实登录态
```

## 包名

`@nonamelane/magpie-gemini-relay`（自用，未注册进 magpie 市场）。
