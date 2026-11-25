# MistralVibe2API

[![CI](https://github.com/handsomezhuzhu/MistralVibe2API/actions/workflows/ci.yml/badge.svg)](https://github.com/handsomezhuzhu/MistralVibe2API/actions/workflows/ci.yml)

把你的 **Mistral Vibe API key** 变成一个任何第三方 agent 都能用的供应商：一个反代，把请求伪装成官方 Vibe CLI 发出的样子转发给 Mistral。

可以当 **magpie / OpenCode 插件**用（推荐），也可以当**独立反代服务器**用（OpenAI 兼容 + Anthropic 兼容）。

> **背景**：Mistral 通知自 2026-12-01 起，通过非 Mistral 产品（第三方编程工具 / harness）使用 Vibe key 的用量将计入每月的免费 API 额度，而不再计入 Vibe 额度。本项目的思路是：让请求在 Mistral 侧看起来就是官方 Vibe CLI 发出来的。

---

## 调研结论：Vibe CLI 是如何发起请求的

以下全部读自官方开源仓库 [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)（v3.1.5）及其依赖的 SDK：

### 端点与认证

| 项目 | 值 |
| --- | --- |
| 推理端点 | `POST https://api.mistral.ai/v1/chat/completions`（OpenAI 兼容，流式 `stream: true`） |
| 认证头 | `Authorization: Bearer <Vibe API key>` |
| key 的来源 | `chat.mistral.ai/code/extensions`（Console → Code → Vibe CLI），类型为 **Vibe**，与 Studio key 分开管理、单独计量 |
| 其他地址 | `https://console.mistral.ai/api/vibe/whoami`（返回租户的 `vibe_base` / `api_base`）、`https://chat.mistral.ai/api/v1/code/managed-config`（企业管控配置） |

代码依据：

- `vibe/core/config/_defaults.py`：`DEFAULT_MISTRAL_API_BASE = "https://api.mistral.ai/v1"`、`DEFAULT_VIBE_BASE_URL = "https://chat.mistral.ai"`
- `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/adapters/mistral.py`：`execute_mistral_completion()` 用官方 `mistralai` SDK 的 `client.chat.stream_async(...)` 发请求，`server_url` 由 `api_base` 推导
- `pyproject.toml`：CLI 固定依赖 `mistralai==3.5.0`

### 请求长什么样

CLI 实际发出的请求（抓包等价物）：

```http
POST https://api.mistral.ai/v1/chat/completions
Authorization: Bearer <Vibe key>
User-Agent: speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai
Content-Type: application/json
Accept: text/event-stream        # 流式时
```

```json
{
  "model": "mistral-medium-latest",
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.2,
  "max_tokens": 4096,
  "tools": [{"type": "function", "function": {"name": "...", "parameters": {...}}}],
  "parallel_tool_calls": true,
  "reasoning_effort": "medium",
  "stream": true
}
```

要点：

- **User-Agent 是 `mistralai` Python SDK（Speakeasy 生成）的 UA**：`speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai`（版本号随 SDK 升级，见 `mistralai/client/_version.py`）。除此之外 SDK 不发任何自定义头。
- 请求体就是标准 OpenAI chat completions；`reasoning_effort` 只对会推理的模型发；Mistral 拒绝 greedy sampling 带 `top_p`，所以 CLI 有温度时才带 `top_p`。
- 响应是标准 OpenAI SSE（`choices[0].delta.content` 可能是字符串，也可能是 `[{type:"text"}]` / `[{type:"thinking"}]` 分片数组；usage 在最后一个 chunk）。

### CLI 实际请求的模型名：`mistral-vibe-cli-*`

用真实 Vibe key 实测 `/v1/models` 和 `/v1/model-catalog?surface=vibe-code`（CLI 自己读这个目录）发现：

| 线报模型名 | 实际身份 |
| --- | --- |
| `mistral-vibe-cli-latest` | harness `LocalModelRoute` 的默认模型，即 Mistral Medium 3.5（`mistral-medium-latest` 的别名） |
| `mistral-vibe-cli-with-tools` | 联网搜索等 utility 调用的默认模型 |
| `mistral-vibe-cli-fast` | 快速 utility 模型（标题生成等） |

模型目录原文（节选）：`{"id":"mistral-medium-latest","label":"Mistral Medium 3.5","aliases":["mistral-medium","mistral-medium-3.5","mistral-vibe-cli-latest"],"max_context_length":262144,...}`。

**这很可能是计量归属的真正开关**：Mistral 的 Vibe 表面按模型名路由（目录里还有 `zai-glm-5-3-flash-vibe-free` 这种 Vibe 专属变体），所以代理默认优先使用 `mistral-vibe-cli-*` 系列名字，其次才是通用模型名。

### Vibe 表面目录全貌（实测 6 条）

`GET /v1/model-catalog?surface=vibe-code` 只返回 Vibe 表面可用的模型（对比 `/v1/models` 的 63 个通用模型）：

| id | 名称 | 上下文 | 备注 |
| --- | --- | --- | --- |
| `mistral-large-4-0` | Mistral Large 4 | 1M | 目录标记 recommended |
| `mistral-medium-latest` | Mistral Medium 3.5 | 256K | 别名含 `mistral-vibe-cli-latest` |
| `zai-glm-5-3` | GLM 5.3 | 1M | 无视觉 |
| `zai-glm-5-3-flash` | GLM 5.3 Flash | 1M | |
| `zai-glm-5-3-flash-vibe-free` | GLM 5.3 Flash（免套餐变体） | 256K | **不是"免费不计费"**，见下 |
| `deepseek-v4-1-flash-1017` | DeepSeek V4.1 Flash | 1M | |

**关于 `-vibe-free` 的实测结论**：它与普通版 `zai-glm-5-3-flash` 的响应头、usage、限流逐字段一致，目录条里也没有任何 pricing/free 字段，而 GLM 5.3 Flash 在 API 定价页明码标价（$0.15/M in、$0.5/M out）。它的上下文被砍到 256K、aliases 挂着普通版 id——形态上是"免费套餐用户的降配路由"，**不是不消耗额度的白嫖通道**。

### Mistral 靠什么区分"Vibe 用量"和"API 用量"

公开信息拼出来的一致结论：

- Mistral 帮工单明确说 *"the Vibe API key is handled differently than the others as we want to provide higher token and rate limit for using the Vibe CLI"*——Vibe key 是单独的类型。
- 付费套餐Console 有两条额度：**Included API usage**（约 $30/月）和 **Included Vibe Code usage**（约 $300/月），每月 1 日 UTC 重置；Enterprise 的 Admin usage API 里 `vibe_usage` 与 `chat`/`completion` 也是分开的项。
- 2026-12-01 起的邮件说明：**按请求来源**分流——非 Mistral 产品发来的用量记到 API 额度。

因此本项目的策略是让转发请求在协议层面与 Vibe CLI 完全一致：

1. 同一个端点 `https://api.mistral.ai/v1/chat/completions`；
2. 同一个 Vibe key（Bearer）；
3. 同一个 User-Agent（`speakeasy-sdk/python 3.5.0 …`，可用环境变量/插件选项覆盖，SDK 升级时跟着改）；
4. **优先使用 Vibe 表面的模型名**（`mistral-vibe-cli-latest` 等），这是 CLI 真正发上去的线报名；
5. **只透传 `content-type` 和 `accept`**，其余客户端头全部剥掉（`user-agent`、`x-stainless-*`、`x-title`、`origin`、`referer`、`anthropic-*`、`x-api-key`、cookie……）， Mistral 看不到前端是哪个 harness。

### 关键实测：计量归属由 key 类型决定，不是客户端指纹

用三种 key 交叉实测（2026-11，同账户）：

| key 类型 | `whoami` 的 `plan_type` | 能用的模型 | 用量记哪个池 |
| --- | --- | --- | --- |
| Vibe key（付费） | `CHAT` | 完整目录（DeepSeek、GLM 1M、Large 4…） | **Vibe 池** |
| Vibe key（免费） | `CHAT` | 仅 `*-vibe-free` 变体（完整版 403 `tier_not_allowed`） | **Vibe 池** |
| API key（非 Vibe） | `API` | 完整目录，但 `*-vibe-free` 反而 403 | **API 池** |

决定性的对照实验：拿 API key 用**完整的 Vibe CLI 指纹**（同 UA + `mistral-vibe-cli-latest` 模型名）发 3 个请求——

- Vibe 池（$300）：**$0 变化**
- API 池（$30）：**+$0.0073**（与按 CLI 公式算出的成本一致）

**结论：反代能让任何 key 在功能上跑通（端点 / UA / 模型名全部接受），但"用量记 Vibe 额度"这个好处只有 Vibe 类型 key 能拿到**——Mistral 按 key 类型分流，UA 和模型名改不了归属。所以本项目的正确用法是**接入 Vibe key**（chat.mistral.ai/code/extensions 创建的那种）；API key 接进来功能正常，但计费上没有收益。

实测补充（2026-11，真实 Vibe key）：

- 三种组合（Vibe UA + vibe-cli 模型 / Claude UA + vibe-cli 模型 / 无 UA + 通用模型）都返回 200，限流头一致（1M tokens/min、2000 req/min，即 Vibe 套餐级限额，跟着 key 走）；
- `console.mistral.ai/api/vibe/whoami` 用该 key 可查（返回 `plan_type`、`api_base`、`vibe_base`）；其余用量端点（`/api/vibe/usage` 等）是 dashboard 会话鉴权，API key 拿不到——所以插件的 usage 钩子默认不查；
- 代理全链路（OpenAI 流式、Anthropic `/v1/messages`、`mistral-vibe-cli-latest` 模型）实测通过。
- **计量归属已实锤**：经代理发请求后，`/v1/billing/budget` 里 `vibe_budget` 的百分比上涨幅度与本地按 CLI 公式算出的成本**分毫不差**（$0.000954），`api_budget` 一动不动——代理流量全部计入 Vibe 额度。

---

## 用量、缓存命中与消耗：能拿到什么

Mistral 的计费用量分三个层次，全部实测可用（Vibe key 即可，无需 Enterprise）：

### 1. 每请求的缓存命中与 token 明细（无需额外端点）

每次 chat completion 响应的 `usage` 里就有，流式的最后一个 chunk 同样带：

```json
"usage": {
  "prompt_tokens": 3012, "completion_tokens": 4, "total_tokens": 3016,
  "prompt_tokens_details": { "cached_tokens": 2944, "cache_write_tokens": 0 },
  "completion_tokens_details": { "reasoning_tokens": 0 },
  "service_tier": "standard"
}
```

- `prompt_tokens_details.cached_tokens`——**缓存命中**的输入 token（Mistral 自动缓存，重复 prompt 第二次即命中，实测命中率 97.7%）
- `prompt_tokens_details.cache_write_tokens`——写入缓存的 token
- `completion_tokens_details.reasoning_tokens`——推理 token

CLI 自己的记账读的就是这几个字段（harness `adapters/_reply_usage.py` 的 `RustTokenUsage`）。代理的 Anthropic 转换会把它们映射成 Claude Code 认得的 `cache_read_input_tokens` / `cache_creation_input_tokens`。

### 2. 账号级余额与消耗（Vibe key 直接可查）

CLI 自己的账号读取（`vibe/app_server/_billing.py`）用这两个公开端点：

```bash
curl -H "Authorization: Bearer $VIBE_KEY" https://api.mistral.ai/v1/billing/subscription
# {"plan_name":"INDIVIDUAL","payg_enabled":false,"vibe_payg_enabled":false,"enterprise":false}

curl -H "Authorization: Bearer $VIBE_KEY" https://api.mistral.ai/v1/billing/budget
# {"vibe_budget":{"usage_percentage":13.92,"initial_budget":300.0,"currency":"USD",
#                 "reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},
#  "api_budget":{"usage_percentage":0.92,"initial_budget":30.0,...}}
```

- **Vibe 额度**（`vibe_budget`）和 **API 额度**（`api_budget`）是两个独立的池，每月 1 日 UTC 重置——双池结构在此实锤
- `/budget` 需要 key 带 `see_org_inference_usage` 权限；没有该权限的成员会拿到 403，属正常
- 另有 `console.mistral.ai/api/vibe/account-context`（组织/工作区/付费 entitlement）和 `/api/vibe/whoami`

### 3. 本地成本核算（CLI 同款公式）

插件和独立反代按 CLI 的公式（harness `_completion_budget.py` 的 `CompletionPricing.cost`）用官方定价（mistral.ai/pricing/api）计算每次请求的成本：

```
cost = (未命中输入 × 输入价 + 命中输入 × 缓存价 + 输出 × 输出价) / 1,000,000
```

实测该公式算出的 $0.000954 与 billing 端点的实际扣减完全一致。没有公开标价的模型（Medium 3.5 等 Vibe 套餐内模型）不计价，`cost_known` 标记为 false 而不是当 0。

**用法**：

- magpie 插件：`auth.usage` 钩子自动把 `/v1/billing/budget` 渲染成账号卡片上的两条额度窗口（`magpie quota` 可见）
- 独立反代：`GET /usage` 一次性返回本地累计统计（按模型分组的请求数、输入/输出/命中/推理 token、成本、缓存命中率）+ 实时 billing 读取

---

## 方案一：magpie / OpenCode 插件（推荐）

插件把 Vibe key 注册成一个供应商，magpie 网关负责协议转换（Anthropic / Responses / Chat 互转）、多账号、故障切换，插件的 `fetch` 负责把请求改成 Vibe CLI 的指纹后转发。

```bash
# 从 git 仓库安装（推荐，任何人可用）
magpie plugin add github:handsomezhuzhu/MistralVibe2API

# 或本地目录就地加载（不改动任何文件）
magpie plugin add /path/to/MistralVibe2API

# 登录：粘贴你的 Vibe key
magpie plugin login mistral-vibe

# 验证
magpie plugin
magpie provider test mistral-vibe
```

之后所有 agent 都可以用 `mistral-vibe/mistral-vibe-cli-latest` 这样的模型 id。

> 首次添加插件时 magpie 会自动下载 Bun 运行时（约 110MB），之后所有插件都跑在它上面。

插件选项（`magpie plugin options mistral-vibe '<json>'`）：

| 选项 | 说明 |
| --- | --- |
| `upstreamBase` | 覆盖上游，默认 `https://api.mistral.ai/v1`（区域端点如 `https://api.eu.mistral.ai/v1`） |
| `userAgent` | 覆盖伪装的 User-Agent |
| `extraHeaders` | 额外上游头，如 `{"origin": "https://chat.mistral.ai"}` |
| `usageUrl` | 可选用量查询地址，返回 `{plan, used, limit}`；Mistral 没有公开的按 key 用量 API，默认不查 |
| `keyPreference` | 路由偏好：`"vibe"`（默认，Vibe key 优先）/ `"api"`（API key 优先）/ `"quota"`（按各自额度余额均衡） |

## Key 类型识别与路由策略

Mistral 有两种 key（同一账户下两条额度池）：**Vibe key**（`chat.mistral.ai/code/extensions` 创建，whoami 报 `plan_type: CHAT`，用量记 **Vibe 池**）和 **API key**（Console 创建，`plan_type: API`，用量记 **API 池**）。计量归属由 key 类型决定，客户端指纹改不了（已实测）。

插件因此：

1. **登录时识别并标注**：`authorize` 调 whoami 判定类型，账号显示为 `vibe · …1f01` / `api · …1LwX`，类型存入 `metadata.keyType`；key 被拒时明确报错，whoami 不可达时按 `unknown` 接纳（不影响使用）
2. **已有 key 自动补识别**：在插件升级前登录的账号没有 `metadata.keyType`，loader（首次使用）和 usage（额度读取）会调一次 whoami 补判，并写回账号——**每个 key 只问一次 whoami，不是每次读取都问**。写回用快照比对防竞态（识别期间账号被登出/刷新则放弃写入），写入失败不影响当次读取
2. **usage 报该 key 真正消耗的额度池**：Vibe key 报 Vibe 池，API key 报 API 池；另一个池作为 `aside` 窗口展示（卡片可见、路由不读）
3. **按 `keyPreference` 决定谁接流量**：
   - `vibe`（默认）：Vibe key 的池计数，API key 全 aside（standby）——流量优先走 Vibe 池，**Vibe 池耗尽后自动故障切换到 API key**（窗口 renewal 后自动回来）
   - `api`：反向
   - `quota`：两种 key 各自的池都计数，路由按剩余额度均衡

只登录了一种 key 时偏好自动失效（唯一的账号照常服务），不会有"偏好导致无账号可用"的问题。

### 偏好怎么在 magpie 路由里生效（重要）

**这不是插件注册的自定义路由策略，而是 usage 窗口通道**：非偏好类型的 key 所有窗口都标 `aside`（magpie 文档：aside 窗口"展示但路由永不读"），于是内置策略把它当作"用量未知"的座位。源码验证过自定义策略拿到的 seats 里没有 key 类型（只有 `key/account/known/used/soon/...`），所以按 key 类型偏好只能走这个通道。

生效前提：**provider / 分组 / 网关 key 的路由必须是会读窗口的策略**——`smart`（默认）、`usage`、`pace` 或 `drain`。若被设成 `order` 或 `rotate`，窗口不被读取，偏好退化成账号列表顺序：

```bash
magpie gateway-key routing <key-id>   # 查看/设置网关 key 的路由
magpie group list                     # 查看含 mistral-vibe 模型的分组路由
```

默认 `smart` 下的行为（阈值来自 magpie 源码 `LowShare=90` / `SpentShare=98`）：

| 偏好池用量 | 行为 |
| --- | --- |
| < 90% | 偏好类型的 key 接流量 |
| 90%–98% | 自动切到 standby key（留余量） |
| ≥ 98% | standby 服务 |
| 月初重置 | 自动切回偏好类型 |

想"榨干偏好池再切换"用 `drain` 路由（约 98% 才换）。

模型列表：插件启动时带一份静态目录，严格对齐 Vibe 表面（`mistral-vibe-cli-latest` 等 CLI 线报名 + 目录里的 6 个模型），登录后先向上游 `/v1/model-catalog?surface=vibe-code`（CLI 同款目录）合并账号实际可用的模型，失败再退 `/v1/models`，再失败用静态目录。

## 方案二：独立反代服务器

零依赖（Node ≥ 18），同时讲 **OpenAI** 和 **Anthropic** 两种协议：

```bash
MISTRAL_API_KEY=你的Vibekey node src/server.mjs
# 默认监听 http://127.0.0.1:8317
```

路由：

| 路由 | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 兼容，流式原样透传 |
| `POST /v1/messages` | Anthropic 兼容（Claude Code 用），自动转成 chat completions 再转回 Anthropic SSE |
| `POST /v1/messages/count_tokens` | 本地估算，不打扰上游 |
| `GET /v1/models` | 透传上游列表，失败时回退静态目录 |
| `GET /usage` | 本地累计统计（按模型：请求数、token、缓存命中、推理 token、成本）+ 实时 billing（额度/套餐） |
| `GET /health` | 健康检查 |

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8317` / `127.0.0.1` | 监听地址 |
| `MISTRAL_API_KEY`（或 `VIBE_API_KEY`） | 无 | Vibe key；不配则要求客户端自带 key |
| `ALLOW_CLIENT_KEY` | 关 | 置 `1` 时优先用客户端自己的 Bearer token（多租户） |
| `MISTRAL_UPSTREAM_BASE` | `https://api.mistral.ai/v1` | 上游地址 |
| `VIBE_USER_AGENT` | `speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai` | 伪装的 UA |
| `VIBE_EXTRA_HEADERS` | 无 | JSON，额外上游头 |
| `MODEL_MAP` | 无 | JSON，模型别名，如 `{"fast":"mistral-small-latest"}` |
| `QUIET` | 关 | 置 `1` 关闭请求日志 |

### 接到各种 agent

**Claude Code**（Anthropic 协议）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_AUTH_TOKEN=任意占位符        # 真实 key 在代理侧
export ANTHROPIC_MODEL=claude-sonnet-4-5      # 或用 MODEL_MAP 映射到 Mistral 模型
claude
```

**Codex / 其他 OpenAI 兼容 agent**：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8317/v1
export OPENAI_API_KEY=任意占位符
```

**magpie 网关**（远程/集中出口）：在 magpie 里加一个 `@ai-sdk/openai-compatible` 供应商指向 `http://127.0.0.1:8317/v1` 即可，或者直接用上面的插件。

---

## 测试

```bash
node --test                              # 全部用例（live 无 key 自动跳过）
MISTRAL_API_KEY=mstrl_… node --test test/live.test.mjs   # 线上回归（真调 Mistral，本地手动跑）
```

覆盖内容：

- **单元/契约**：头改写、Anthropic ⇄ OpenAI 双向转换（tool_use / thinking / 缓存字段）、SSE 编解码、计费端点与成本公式（CLI 同款）、包与插件契约（`package.json` 字段、发现关键词、防 key 泄漏扫描）、目录与价格表一致性
- **全链路模拟**（`test/integration.test.mjs`）：一个 mock Mistral 上跑完登录（含 key 类型识别）→ 供应商声明 → 模型目录 → loader fetch（普通/流式/工具调用，校验 Vibe 指纹）→ usage 读数，无需 key 和网络
- **端到端**（mock 上游）：流式/非流式透传、错误透传、模型别名、`/usage` 统计聚合
- **线上回归**（`test/live.test.mjs`，需 key）：模型列表、Vibe 表面模型名、工具调用、流式、自动缓存命中、billing 双池、插件 usage 钩子读真实数据、客户端指纹防漂移

### CI（GitHub Actions）

`.github/workflows/ci.yml`：Node 18/20/22/24 × Ubuntu/Windows/macOS 共 12 个组合跑全量用例 + `npm pack --dry-run` 打包校验，push 到 master/main 和 PR 自动触发。**CI 只跑模拟测试**（不配 key、不花额度、不受 key 套餐差异影响）；线上回归留在本地手动跑。

## 风险与限制

- **这是指纹伪装，不是官方通道。** Mistral 随时可以改判定逻辑（比如要求 SDK 签名、TLS 指纹、额外的 vibe 专属头）。UA 可配置就是为了跟随官方 SDK 版本变化；如果失效，先检查 `mistralai` SDK 的 `_version.py` 更新 `VIBE_USER_AGENT`。
- Vibe key 的额度、限流由 Mistral 侧控制；超出套餐后表现（PAYG 或停用）取决于你自己的账单设置。
- 反代看得见全部流量，只建议跑在本地或你信任的机器上；不要把代理端口暴露到公网。
- 本项目与 Mistral 无关联，使用请自行评估是否违反其服务条款。

## 开发

```
index.mjs          magpie/OpenCode 插件入口（provider + auth + loader fetch + usage）
src/core.mjs       上游指纹逻辑（头改写、key 解析、模型目录、价格表、计费查询、用量累计）
src/anthropic.mjs  Anthropic ⇄ OpenAI 协议转换 + SSE 编解码（含缓存字段映射）
src/server.mjs     独立反代服务器（/v1/chat/completions、/v1/messages、/usage）
test/              node:test 用例
```
