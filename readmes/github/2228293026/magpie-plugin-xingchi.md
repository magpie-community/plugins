# magpie-plugin-xingchi

星驰 API 网关（<https://api.xingchiapi.com>）的 magpie / OpenCode 供应商插件。

网关是 OpenAI Responses 兼容的编程客户端网关，只放行已知的编程客户端；插件负责
三件网关特有的事：**User-Agent 白名单**、**Responses 协议改写**和**每日签到**。

## 安装

```sh
magpie plugin add postdare/magpie-plugin-xingchi   # 从 GitHub 装
magpie plugin login xingchi                        # 选一种登录方式
magpie provider test xingchi                       # 冒烟
magpie quota                                       # 看额度
```

也可以把仓库克隆下来就地加载：

```sh
magpie plugin add ./magpie-plugin-xingchi
```

之后模型以 `xingchi/gpt-5.6` 这样的 id 出现。

## 三种登录方式

`magpie plugin login xingchi` 会让你选：

| 方式 | 怎么填 | 能用模型 | 能自动签到 |
| --- | --- | --- | --- |
| **Xingchi 浏览器登录** | 点一下，在弹出的浏览器里登录 | ✅ | ✅ |
| **Xingchi API key** | `sk-…` | ✅ | ❌ |
| **Xingchi 网页令牌** | 浏览器里的 `access_token` | ✅ | ✅ |

### 浏览器登录（推荐）

选「Xingchi 浏览器登录」后，插件会起一个独立的 Chrome / Edge 窗口并打开
<https://xingchiapi.com/login>。你在那个窗口里正常登录（邮箱密码 + Turnstile，
或者 linux.do / GitHub 第三方登录都行），**登录完插件自动接手**，不用复制任何东西。

插件做的是：给浏览器开一个调试端口，用 CDP 读页面里的
`localStorage.auth_token` / `refresh_token`，再拿这个会话去面板的
`/api/v1/keys` 挑一把（或新建一把）API key 供网关用。整个过程不需要你的密码。

浏览器 profile 独立存放在：

| 平台 | 路径 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\magpie\xingchi-browser` |
| macOS / Linux | `~/.config/magpie/xingchi-browser` |

所以登录过一次之后，下次登录通常不用再输密码。可以用环境变量改：

- `XINGCHI_BROWSER` —— 指定浏览器可执行文件（默认自动找 Chrome / Edge）
- `XINGCHI_PROFILE` —— 指定 profile 目录

### 为什么签到不能只靠 API key

签到接口在面板的 `/api/v1/user/checkin` 下，鉴权走的是**网页登录的 JWT**，
不是 API key（拿 API key 去调会被判成 `INVALID_TOKEN`）。而面板登录被
Cloudflare Turnstile 挡着，程序化提交会被拒（`turnstile verification failed`），
所以要么用真浏览器登录（上面的浏览器登录），要么手动复制一次令牌（网页令牌方式）。

### API key 必须绑定分组

面板里的 API key 必须挂在一个分组（group）上，否则网关直接回 403：

```
{"error":{"message":"API Key is not assigned to any group and cannot be used.
 Please contact the administrator to assign it to a group.","type":"permission_error"}}
```

浏览器登录时插件会自己处理这件事：

1. 先看面板里现有的 key，**只挑已经绑定分组的**；
2. 没有的话，从 `/api/v1/groups/available` 取一个可用分组；
3. 如果有一把插件自己建的（名字是 `magpie`）没绑分组，给它补上分组；
4. 都没有就新建一把，**并且带上 `group_id`**。

### 多账号

同一个供应商可以登录多个账号，每个账号单独记一套凭据：

```sh
magpie plugin login xingchi   # 再来一次，用另一个账号登录
```

插件会把面板里的邮箱作为账号标识（`accountId`）交给 magpie，所以不同邮箱的
登录会被存成不同账号，在供应商页和路由组里可以分别选、分别签到、分别看额度。
用同一个邮箱重复登录则是替换掉原账号。

### 每日签到

签到走 magpie 的 `auth.checkin` 钩子：开了签到开关后，magpie 每个北京日为每个
已登录账号调一次，结果显示在账号的用量卡片和设置里。

**取令牌**：先在浏览器登录 <https://xingchiapi.com/dashboard>，然后在控制台执行

```js
copy(JSON.stringify({
  access_token: localStorage.getItem("auth_token"),
  refresh_token: localStorage.getItem("refresh_token"),
}))
```

把复制到的 JSON 整块粘进「网页 access_token」那一栏即可；`refresh_token` 会
一并带出来（留空也能签，只是会话过期后要重新登录）。API key 那栏可以留空，
插件会用会话去面板的 `/api/v1/keys` 里自动挑一把现成的，没有就建一把。

```sh
magpie plugin login xingchi   # 选「Xingchi 网页令牌」
```

之后：

```sh
magpie quota        # 额度窗口上会多一个「每日签到」条目
```

面板接口实测：

| 接口 | 返回 |
| --- | --- |
| `GET /api/v1/user/checkin` | `{ enabled, claimed_today, amount, total_count, total_amount }` |
| `POST /api/v1/user/checkin` | `{ status: { … }, amount }` |
| 重复领取 | `{ code, message, reason: "CHECKIN_ALREADY_CLAIMED" }` |

插件把结果映射成 magpie 的签到语义：

| 面板状态 | outcome |
| --- | --- |
| `enabled: false` | `inactive`（站点没开签到活动） |
| `claimed_today: true` | `done`（今天已签，带累计次数） |
| 领取成功 | `claimed`（带 `credit` 额度与 `streak` 累计次数） |
| `CHECKIN_ALREADY_CLAIMED` | `done` |
| 会话过期且 refresh_token 也失效 | `failed`（提示重新登录） |

会话过期时插件会用 `refresh_token` 调 `POST /api/v1/auth/refresh` 换一张新令牌，
并把它写回账号，所以正常情况下不会中途掉线。浏览器登录的账号还挂了 magpie 的
`auth.refresh` 钩子：令牌快过期时 magpie 会主动续期并写回。

## 选 UA

网关按 UA 第一段放行客户端，UA 就是「用哪个客户端身份访问网关」：

```sh
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude"}'
```

可用预设：`opencode`（默认）、`claude`、`cline`、`cursor`、`omp`、`pi`、`kilo`、`roo`，
也可以直接给完整的 UA 字符串。不选时保留上游 agent 自带的 UA（若在白名单里）。
详见下面的「User-Agent 白名单」。

## 网关限制与本插件的处理

### 1. User-Agent 白名单

网关按 UA 的**第一段**（`/` 之前）判定客户端。实测规则：

- 只看第一段，版本号不参与校验（`opencode/任意版本` 都放行，`zzz/1.0` 被拒）；
- 大小写不敏感（`OPENCODE/1.0` 与 `opencode/1.0` 都放行）；
- 必须是 `<token>/…` 的形式，单独的 `opencode` 被拒。

实测放行的 token：

`claude-cli`、`claude-code`、`opencode`、`omp`、`pi`、`cline`、`cursor`、`trae`、
`qoder`、`minis`、`zcode`、`hermes`、`hermes-agent`、`workbuddy`、
`deepseek-harness`、`kilo-code`、`roo-code`

其余（例如 Bun 默认的 `Bun/1.4.2`）返回 403：

```json
{"error":{"code":"client_not_allowed","message":"本站仅支持编程客户端使用：…"}}
```

网关自报的支持列表（Codex、Kilo、Roo、Copilot、Grok）与实际放行集**不一致**：
`codex_cli_rs`、`kilo`、`roo`、`copilot`、`grok-cli` 实测都被 403 拒绝。

#### 选 UA

UA 就是「用哪个客户端身份访问网关」，所以插件把它做成可选项：

```sh
# 预设名（客户端名 + 该客户端的真实版本格式）
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude"}'

# 或完整的 UA 字符串
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude-cli/2.1.327 (external, cli)"}'
```

可用预设：

| 预设 | 实际发送的 UA |
| --- | --- |
| `opencode`（默认） | `opencode/1.19.6` |
| `claude` | `claude-cli/2.1.327 (external, cli)` |
| `cline` | `Cline/3.0.74` |
| `cursor` | `Cursor/1.0.3` |
| `omp` | `omp/18.22.2` |
| `pi` | `pi/1.5.2 (darwin; node; arm64)` |
| `kilo` | `kilo-code/7.8.27` |
| `roo` | `Roo-Code/3.0.0` |

每个预设的客户端名和版本号都取自该客户端自己（npm 上的当前版本 /
客户端自己的 UA 构造代码），不是随手编的。

不选时的行为：

- 上游 agent 自带的 UA 若在白名单里就**原样保留**（例如 Claude Code 的
  `claude-cli/2.1.327 (external, cli)`），网关看到的仍是真实客户端；
- 否则替换成默认的 `opencode/1.19.6`；
- 若选中的 UA 被网关 403 拒绝（`client_not_allowed`），插件自动用默认 UA 重试一次。

### 2. Responses 协议

网关实测行为：

| 网关行为 | 插件的改写 |
| --- | --- |
| `previous_response_id` → `previous_response_id is not available for this user` | 删除该字段 |
| `store: true` 无链可用 | 强制 `store: false`，每轮全量回放上下文 |
| `input` 数组里的 `system` / `developer` 角色被丢弃；只发这些角色时上游报 `One of "input" or "previous_response_id" … must be provided` | 提升为 `instructions`；若 input 里只剩 system，则降级成一条 user 消息 |

`chat/completions` 形态的请求体（含 `messages`）原样放行。

### 3. 每日签到

见上面的「每日签到」一节。签到接口不在网关的 `/v1` 下，而在面板的 `/api/v1`
下，用网页登录的 JWT 鉴权。

### 4. 按模型的上游通道（能力实测，不写死）

网关按模型分上游账号池，**池子会变**：

- `/v1/models` 只列出这个账号池现在真能用的模型。清单之外的模型会报
  `Model "x" is not supported by any configured account in this group`。
  插件的 `provider.models` 钩子以这个实时清单为准，静态清单只用来补名字和
  上下文/输出上限。
- **能不能带工具调用，取决于该模型当前被路由到哪个上游账号**，也会变。
  同一个 `gpt-6.1-sol`：某天带工具被拒（`requires Responses for tool calls;
  this account only supports Chat Completions`），另一天又正常。

所以插件登录后**逐个实测**每个模型的工具能力：发一个带 `tools` 且
`tool_choice` 强制调用的小请求，按网关的回答分类：

| 网关回答 | 判定 |
| --- | --- |
| 2xx | 支持工具 |
| 明确说不支持工具（`only supports Chat Completions` 等） | 不支持，`tool_call: false` |
| 限流 / 5xx / 模型不在池子里 / 网络问题 | **没测出来**，保留原值，不当成不支持 |

探测用 `tool_choice` 强制调用：只带 `tools` 而不强制时，模型可以走纯文本回答，
网关的通道检查就不会触发（实测 `tool_choice: none` 在不支持工具的通道上也通过，
会误判成支持）。

探测结果按（网关, key, 模型）缓存 6 小时，最多 4 个并发——账号池不会几分钟一变，
不必每次登录都重打一轮。

### 5. 其他已验证事实

- 工具调用：Responses 的 `function_call` / `function_call_output` 与 chat 的
  `tool_calls` / `tool` 角色都正常；`strict: true` 也被接受。
- 推理：`reasoning.effort`（Responses）与 `reasoning_effort`（chat）接受
  `minimal / low / medium / high / xhigh / max`。
- 流式：Responses 返回标准 `response.*` SSE 事件；chat 返回标准 `chat.completion.chunk`。
- 限流：`Upstream rate limit exceeded`、`Service temporarily unavailable`
  是上游账号的配额与抖动，与协议无关；换个模型或过一会儿就好。
- 上下文：实测 gpt-5.6 接受 600k+ token 的输入（网关不截断）。
- 图片模型（`gpt-image-*`）在本账号未开通（`Image generation is not enabled for this
  group`），插件不暴露它们。

## 全部渠道（分组）与倍率

面板按**分组**划分模型：每个分组有自己的倍率（`rate_multiplier`）和自己的模型清单，
而**一把 API key 只属于一个分组**（用别的分组的 key 请求，会得到
`Model "x" is not supported by any configured account in this group`）。

所以「同时显示全部渠道」的做法是：

1. 插件读面板的分组清单（`/api/v1/groups/available`），每个分组各配一把 key
   （现成的优先，没有就建一把，名字 `magpie-g<分组id>`）；
2. 每个分组的模型清单都用**那把 key** 去问网关；
3. 同一个模型在多个分组都有时，各算一条，显示名后面带倍率：

   | 模型 id | 显示名 |
   | --- | --- |
   | `gpt-6.1-sol` | GPT-6.1 Sol · 0.5x |
   | `gpt-6.1-sol-g4` | GPT-6.1 Sol · 1x |

4. 模型 id 上的 `-g<分组id>` 标记经 `apiId` 传到 loader，loader 据此换成那个分组的
   key，并把标记从请求体里去掉再发给厂商。

**余额不足的渠道会标出来。** 有些分组从「专属余额」里扣钱（`balance_source:
dedicated`），账号没有那笔余额时列出来也是 503，所以名字后面会加「（余额不足）」，
渠道仍然列出来（你能看到有哪些渠道），但别去选它。

分组信息缓存在插件旁边的 `xingchi-groups.json`：只有 API key 的账号没有面板会话，
读这份缓存才能标出倍率。

## 模型

登录后插件拉网关的**实时清单**（`/v1/models`），只列出这个账号池现在真能用的文本模型；
图片模型（`gpt-image-*`）过滤掉。

静态兜底清单里有 16 个 id 及其上下文/输出上限（取 omp 内置目录里同名 id 的值：
`gpt-5.6-*`、`gpt-6-*` 为 272000/128000，`gpt-6.1-*` 为 500000/128000，目录里没有的
用通用默认 128000/32768），只用来给实时清单补名字和上限。

工具能力由实测决定（见「按模型的上游通道」），不写死在清单里。

## 思考等级与「思考过程」显示

模型清单里的等级就是 magpie 发给厂商的 `reasoning.effort`：low / medium / high /
xhigh / max（magpie 还会自己加一个 ultra，它发出去时按 max 处理）。

**思考一定会跑，但「思考过程」不一定显示得出来。** 实测（同一个问题、同一个
模型、`effort=high`、连发 6 次）：

```
摘要事件数：0  2  0  0  2  0
```

每次请求的 `reasoning` 项都在（模型确实在推理），但**摘要文本要不要转发给客户端，
取决于这次请求命中了上游账号池里的哪一个账号**——只有一部分账号会转发 reasoning
摘要。所以界面上的「思考过程」时有时无，和客户端、和插件都无关，是上游账号池的
行为。

插件侧能做的是显式带上 `summary: "auto"`（上游愿意转发时一定会转），已经加了。

另外两点：

- 之前上游返回 2xx 但没有可领的，是 `done` 不是 `failed`，magpie 不会再问；
- 上游的 `/v1/chat/completions` 已停用（`chat_completions_disabled`），
  只能用 Responses API。

## 用量与账号卡片

网关的 `/v1/usage` 现在返回（老版本是 `quota` 对象，两种都认）：

```json
{ "balance": 297.42, "remaining": 297.42, "unit": "USD", "mode": "unrestricted",
  "planName": "钱包余额", "daily_usage": [ … ], "usage": { "today": { … }, "total": { … } } }
```

插件把它映射成 magpie 的账号卡片：

| 卡片上的 | 来自 |
| --- | --- |
| **额度 X / Y USD · 剩余 Z%** | 累计消费 / 累计获得（余额 + 累计消费），带进度条 |
| **今日消费 X USD · N 次请求 · N tokens** | 网关的 `usage.today` |
| **每日签到 今日已签到 · 累计 N 次 ↻ 明天 00:00** | 面板的 `/user/checkin` |
| **余额 X USD** | 顶层的 `balance`，magpie 据此画「余额走势」曲线 |

**关于走势图。** magpie 的规则是：一张卡片**有窗口时，曲线画的是窗口的**，没有窗口
才画余额的曲线（`noteCardHistory`：`q.Balance != "" && len(q.Windows) == 0`）。
所以插件把额度窗口的「剩余」做成**正好等于钱包余额**——窗口的
`limit - amount = 余额`——这样窗口的曲线就是余额走势，而顶层的 `balance`
另外给出卡片底部的「余额」那一行。

窗口的读数由 magpie 记进 `quota-history.json`，读满两次、间隔够久就会画出曲线
（每读一次只留一个点，间隔太近的会顶掉上一个）。

密钥配了额度上限时（面板里的「设置配额上限」），额度窗口改用真的上限，
显示成「已用 / 上限」。

用了「网页令牌」登录时，账号卡片上还会多一个「每日签到」的窗口，显示今天是否已签、
累计签到次数。这是 `aside` 窗口，不参与路由决策。

## 自行测试

```sh
bun test                                        # 单元：UA 选择、请求体改写、能力探测分类、签到状态分类、浏览器登录
XINGCHI_API_KEY=sk-… bun run scripts/smoke.mjs   # 打真实网关
```
