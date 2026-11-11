# ZenMux — Magpie 供应商插件

版本 **0.1.0**，包名 **`magpie-zenmux`**。为 [Magpie](https://usemagpie.ai) 与 [OpenCode](https://opencode.ai) 提供 **ZenMux**（[zenmux.ai](https://zenmux.ai)）统一供应商接入，同时支持 **Builder Plan（订阅制）** 与 **Pay As You Go（按量付费）** 两种 API Key，并在 Magpie 中原生展示 **5 小时 / 7 天滚动 Flow 额度窗口**、**提前重置次数** 与 **按量账户余额**。

插件内置 `assets/icon.svg` 离线图标（同时在 `package.json` 提供 HTTPS 图标地址），零第三方运行时依赖，无需 `npm install` 或构建。

[安装与首次使用](#安装与首次使用) · [在 Magpie 中登录与配置](#在-magpie-中登录与配置) · [功能覆盖范围](#功能覆盖范围) · [订阅与按量混用自动分流](#订阅与按量混用自动分流) · [常见问题排查](#常见问题排查) · [开发与验证](#开发与验证)

---

## 安装与首次使用

### 方式一：直接通过 GitHub 安装（推荐）

```sh
magpie plugin add github:NieiR/magpie-zenmux
```

或在 Magpie 的 **插件（Plugins） → 发现（Discover） → 非官方插件 · GitHub** 中找到 **magpie-zenmux** 点击安装。

### 方式二：克隆到本地目录安装

```sh
git clone https://github.com/NieiR/magpie-zenmux.git
magpie plugin add ./magpie-zenmux
```

> **注意**：如果你之前在 Magpie 中手动添加过名为 `zenmux` 的自定义供应商，插件会按 Magpie 规则自动避让命名为 `zenmux-plugin`。运行 `magpie provider rm zenmux` 删除旧的自定义项后，插件即可直接接管 `zenmux` ID（模型路径为 `zenmux/<供应商>/<模型>`）。

---

## 在 Magpie 中登录与配置

### 理解 ZenMux 的三类密钥

ZenMux 平台将**模型推理密钥**与**账户管理密钥**做了权限隔离：

| 密钥类型 | 前缀 | 创建位置 | 用途 |
|---|---|---|---|
| **订阅 API Key（Builder Plan）** | `sk-ss-v1-…` | [订阅管理页](https://zenmux.ai/platform/subscription) | 调用订阅套餐内的模型，消耗 5h / 7d 滚动 Flow 配额 |
| **按量 API Key（Pay As You Go）** | `sk-ai-v1-…` | [按量付费页](https://zenmux.ai/platform/pay-as-you-go) | 按实际 Token 消耗扣减账户美元余额，可调用全量模型 |
| **Management API Key** | `sk-mg-v1-…` | [Management 页](https://zenmux.ai/platform/management) | **仅用于查询**订阅 5h / 7d 配额、剩余重置次数和按量余额，不能调用模型 |

### 登录步骤

你可以在同一个 `zenmux` 供应商下登录一个或多个账号（例如同时登录一个订阅 Key 和一个按量 Key）：

```sh
magpie plugin login zenmux
```

或在 Magpie 界面打开 **供应商（Providers） → ZenMux → 登录 / 添加账号**：

1. **选择密钥类型**：
   - `ZenMux Subscription API key (sk-ss-v1-…)`（订阅制 Key）
   - `ZenMux Pay-As-You-Go API key (sk-ai-v1-…)`（按量付费 Key）
2. **输入 Management API Key（`sk-mg-v1-…`）**：
   - 首次登录时填入在 `https://zenmux.ai/platform/management` 创建的 `sk-mg-v1-…` 密钥。
   - **添加第二个 Key 时可直接回车留空**：插件会自动复用当前 Magpie 配置中已保存的 `sk-mg-v1-…` 管理密钥。
3. **输入推理 API Key**：
   - 填入对应的 `sk-ss-v1-…` 或 `sk-ai-v1-…` 密钥即可完成登录。

登录完成后，运行 `magpie quota zenmux` 即可查看实时配额与余额：

```text
zenmux · Pay As You Go · API key …6756                   subscription  $26.77 left
zenmux · Builder Starter · until Oct 27 · API key …dff9  subscription  5h 0% (0 / 50 flows · $0.00 / $1.64) ↻4h38m 14:40  7d 5% (9.86 / 213 flows · $0.32 / $6.99) ↻4d4h Wed 14:39  ↺ 4 five-hour resets until Oct 27 18:01
```

---

## 功能覆盖范围

| 功能 | 说明 |
|---|---|
| **订阅 5 小时 / 7 天滚动窗口** | 调 `/api/v1/management/subscription/detail` 展示已用百分比、已用/最大 Flows、折算美元价值及窗口自然重置倒计时 |
| **5 小时窗口提前重置次数** | 映射 `quota_5_hour.remaining_resets` 至 Magpie 的 `resets.fiveHour`，显示当月剩余手动/自动重置机会及套餐到期时间 |
| **Flow 汇率惩罚与异常状态提醒** | 当 `account_status` 异常或 `effective_usd_per_flow > base_usd_per_flow` 时在额度卡片直接显示告警 |
| **按量付费（PAYG）余额查询** | 调 `/api/v1/management/payg/balance` 展示账户当前可用美元总余额（`$total_credits left`） |
| **按套餐等级自动过滤模型** | 订阅 Key（`sk-ss-v1-…`）自动结合当前套餐等级（`starter` / `pro` / `max` / `ultra`）与公开套餐清单过滤可用模型；按量 Key（`sk-ai-v1-…`）开放全量模型 |
| **原生多协议分流** | `anthropic/*` 走 Anthropic Messages（`/api/anthropic/v1/messages`），`openai/*` 走 OpenAI Responses（`/api/v1/responses`），其余对话模型走 Chat Completions（`/api/v1/chat/completions`） |
| **原生联网搜索透传** | 开启 `searches: true`，Claude Code 与 Codex 的原生 `web_search` 请求直接透传至 ZenMux 上游 |
| **精准 403 状态区分** | 区分 ZenMux 的 `403 access_denied`（Key 失效，标记账号需重登）与 `403 safety_check_failed`（内容安全拦截，保持账号在线） |

---

## 订阅与按量混用自动分流

在 Magpie 中同时登录一个 **订阅 Key（`sk-ss-v1-…`）** 和一个 **按量 Key（`sk-ai-v1-…`）** 时，无需开启 ZenMux 网页端的 Extra Usage 即可获得更精细的本地网关路由：

1. **套餐外模型零报错直达按量号**：
   - 例如 Starter 套餐不包含 `anthropic/claude-opus-4.5`、`openai/gpt-5.3-codex` 等 Max/Ultra 模型。
   - 插件为 Starter 订阅号仅注册其支持的模型，为按量号注册全量模型；当你请求 `zenmux/anthropic/claude-opus-4.5` 时，Magpie 会直接跳过订阅号发往按量号，不会触发 `404 model_not_available`。
2. **配额耗尽或限流自动故障切换**：
   - 当订阅号触发 5 小时 / 7 天配额上限（`402 quote_exceeded`）或 10–15 RPM 限流（`429 rate_limit`），或者达到你在 Magpie 中为订阅号设置的用量上限（Usage Cap）时，Magpie 会自动将请求无缝切换到按量号，并在订阅窗口重置后自动切回。

---

## 常见问题排查

| 现象 | 原因与处理方法 |
|---|---|
| 供应商显示为 `zenmux-plugin` 而不是 `zenmux` | 你之前添加过同名自定义供应商 `zenmux`。运行 `magpie provider rm zenmux` 即可让插件接管 `zenmux` |
| 用量卡片提示 `Management API key (sk-mg-v1-…) not set` | 登录时未填管理密钥。前往 [ZenMux Management](https://zenmux.ai/platform/management) 创建 `sk-mg-v1-…`，重新运行 `magpie plugin login zenmux` 填入即可 |
| 调用模型提示 `sk-mg-v1-… is a Management API key` | 把管理密钥填进了推理 API Key 输入框。管理密钥只能填在第一步提示中，API Key 输入框需填 `sk-ss-v1-…` 或 `sk-ai-v1-…` |
| 订阅号里找不到某个模型（如 `claude-opus-4.5`） | 该模型不在你当前的订阅套餐（如 Starter）范围内。可升级套餐，或同时添加一个按量 Key（`sk-ai-v1-…`）由其承接 |

---

## 开发与验证

需要 Node.js 22.19+ / 24+ 或 Bun：

```sh
npm run check
npm test
```

完整验证记录见 [`VALIDATION.md`](./VALIDATION.md)。

## 许可证

[MIT](./LICENSE)
