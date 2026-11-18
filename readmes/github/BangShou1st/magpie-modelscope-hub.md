# magpie-modelscope-hub

插件列表里的显示名：**ModelScope Hub**（`package.json` 的 `magpie.name`）。

一个 magpie 插件包，把魔搭（ModelScope）两件事合到一起：

| | 国内站 modelscope.cn | 国际站 modelscope.ai |
| --- | --- | --- |
| 模型调用（API-Inference） | ✅ `modelscope-cn` | ✅ `modelscope-ai` |
| 魔粒用量卡（余额 / 今日发放 / 今日花费） | ✅ | ✅ |
| 每日签到（自动领当日魔粒） | ✅ | ✅ |
| 账号显示名写回 | ✅ | ✅ |

上游是两个互不相干的插件：`magpie-plugin-msmoli`（只签到，不提供模型）和
`magpie-plugin-ms-ai`（只做国际站推理，顺带国际站签到）。本插件把它们合成
一份代码：装一个插件，两个站各一张卡，每张卡都能调用、能签到、有用量。

---

## 为什么是「一个包、两个 provider」

不是偷懒，是 magpie 的接口决定的：`internal/plugin/host.js` 的 `info()` 列
provider 的模型时，只用 `accountsOf(readAuth(), id)[0]` —— **第一个账号** ——
的身份去问一次 `provider.models` 钩子。一个 provider 里混装国内站和国际站的
令牌，模型目录只会反映第一个账号那个站；另一个站的账号一调用就是 401。

所以两个站各自一个 provider：各有自己的模型目录、用量卡、签到记录，互不串。
但安装、卸载、升级、开关仍然是**一个插件**（`magpie plugin add/rm` 一条命令）。

代价是登录一次只能登一个站：令牌属于哪个站，就登到哪个 provider 上（见下）。

---

## 安装

从 GitHub 装（推荐）：

```powershell
magpie plugin add github:BangShou1st/magpie-modelscope-hub
```

从本地目录装（改源码时用）：

```powershell
magpie plugin add "D:\magpie-plugin\magpie-modelscope-hub"
magpie plugin list          # 应能看到 ModelScope Hub，Provides 两个 provider
```

卸载：

```powershell
magpie plugin rm magpie-modelscope-hub
```

改完源码要重启 magpie（本地目录插件不走 `magpie plugin update`）。

## 登录

令牌在各自站点个人中心生成，形如 `ms-…`；**国内站的令牌在国际站无效，反之亦然**。

```powershell
# 国内站
magpie plugin login modelscope-cn

# 国际站
magpie plugin login modelscope-ai
```

两个站都要用就登两次、各放一个账号。同一个 provider 下可以放多个账号（多把
令牌轮询），每个账号的签到、余额各自独立。

---

## 它怎么工作

### 调用

`auth.loader` 把该账号的请求转发到本站的 API-Inference：

- 国内站 `https://api-inference.modelscope.cn/v1`
- 国际站 `https://api-inference.modelscope.ai/v1`

上游答案原样交回，只额外说明它对「登录」意味着什么：

| 状态 | 含义 | 对账号的处理 |
| --- | --- | --- |
| 401 | 令牌被这一站拒绝 | 标为需要重新登录（`signIn: expired`） |
| 402 | 魔粒用完 | 丢弃用量缓存，下一张卡立刻按「用完」停用 |
| 403 | 没有该模型权限 | 不算登录问题 |
| 429 | 网关限流 | 不算登录问题，退避交给 magpie |

### 模型目录

`provider.models` 每列一次就问一次厂商的 `/models`，按令牌缓存 30 分钟。登录
前或拉取失败时退回内置兜底：

- 国内站 7 个（models.dev 目录里 `modelscope` 一项：Qwen3 系列 + GLM-4.6/4.5）
- 国际站 3 个（上游 2026-11-02 逐个 `provider test` 过、确认可调用的旗舰模型）

国际站目录里那些列得出但调不动的（Ambassador 档 Qwen、400 "has no provider
supported" 的条目）标成 `deprecated`，magpie 会把它们从选择器和路由组里滤掉。
国内站没有逐个实测，不设黑名单。

### 图片与多模态

`/v1/models` 同样给不了「收不收图」。之前每个模型都写 `image: false`，在 magpie
里这不是「不知道」，而是**明说「不支持」**：网关会把图片先描述成文字，视觉模型
也用不上自家的眼睛。现在 `src/modalities.mjs` 按魔搭模型页的 pipeline 标签补：

| pipeline | 例子 | 声明 |
| --- | --- | --- |
| `image-text-to-text` | Qwen3.5 / 3.8 全系、DeepSeek-V4.1、InternVL、ERNIE-VL、Kimi-K3.1、MiniMax-M3、Intern-S | 收图，出文本 |
| `text-generation` | DeepSeek-V4 / V4-Pro、GLM、Nex、Step-5 | 只说自己是文本模型，不硬写「不收图」 |
| `image-to-image` | Qwen-Image-Edit、MusePublic/Qwen-Image-Edit | 只收图、只出图；`output.text: false`，magpie 会把它从聊天列表摘掉，只在画图入口出现 |

2026-11-18 对国内站 38 个模型逐个核过 pipeline 标签。表里没有的新 id 只报文本、
不声明图片能力，将来上的视觉模型仍能收到图，不会被本地网关先挡掉。

### 推理强度

`/v1/models` 只给 id，给不了「是不是思考模型」「支持哪几档推理强度」。不补这张
表，实时目录一拉到，兜底里的 `reasoning: true` 会全丢（线上 38 个模型都变成非
思考模型），选择器里也没有强度可选。所以 `src/capabilities.mjs` 按系列补：

| 系列 | 依据 | 思考 | 强度档位 |
| --- | --- | --- | --- |
| `nex-agi/Nex-N2.5-*` | 模型卡 | ✅ | none / medium / high |
| `Qwen/Qwen3.8-Flash-Next` | 模型卡（默认 xhigh） | ✅ | low / medium / xhigh |
| `Qwen/Qwen3.5-*` | 模型卡（默认思考，开关型） | ✅ | — |
| `Qwen/Qwen3.8-27B` | 模型卡（默认 xhigh） | ✅ | low / medium / xhigh |
| `deepseek-ai/DeepSeek-V4*` | 思考模型（输出 reasoning_content） | ✅ | — |
| `ZhipuAI/GLM-4.5 / 4.6 / 4.7 / 5.2` | models.dev 目录 | ✅ | — |

档位用 OpenCode 的写法 `{ <档位>: { reasoningEffort: <档位> } }`，由
`@ai-sdk/openai-compatible` 发成请求体的 `reasoning_effort`。

没有文档依据的 id 一律不猜：`variants` 留空、`reasoning` 不硬写 true。一个填了
档位但上游不认的变体，会让用户选「high」而实际仍是默认档——比没有更糟。国内站
38 个模型里，15 个标了思考，其中 4 个有档位。

### 一次请求花了多少魔粒？

做不到按请求归因，三个来源都不给这个粒度：

- 推理响应里只有 token 用量，没有魔粒字段，响应头也没有（2026-11-18 实测）
- 账单只有按 (天, 档位) 聚合的 `SPEND_CONFIRM` 行（`model_tier` + `total_amount` + `count`）
- magpie 的账本本身没有按请求的积分记账，并发时余额差也分不清是谁花的
  （`docs/subsystems/providers-accounts.md` 明说不做按次归因）

所以卡片说的是「今天花了 5 魔粒 · 3 次（旗舰 2×2、标准 1×1）」，不是「这一笔 2 魔粒」。
每笔按 2 的估算只在本地用来判断什么时候该提前去读余额。

### 用量卡

两个锚点各按自己的时钟刷新，两次读之间用插件亲眼看见的调用做估算：

- 余额：每 30 分钟读一次；估算花掉锚点的 80%，或剩不到 4 魔粒（两次旗舰调用）时提前读
- 当日账单：翻日时读；估算把当日发放花完时读，但最多 5 分钟一次

估算每笔按旗舰档 2 魔粒算，只会高估消耗、不会高估余额 —— 最坏是提前问一次厂商，
不会出现「以为还有、实际已见底」把账号误停到第二天。

卡片三行：

- **今日发放**（`aside`，只展示）：今日到账 / 已花
- **长期魔粒**（`aside`，只展示）：expire_days > 1 的一次性奖励
- **合计**（参与路由）：`limit = 余额 + 今日已花`，即这笔钱真实的总额；余额归零时
  `used:100` + 下一个北京时间 00:35 的 `resetsAt`，magpie 停用到那时，签到到账后自动恢复

余额没有可分母的配额时（账单读不到、或今天只有长期池），画成钱包窗口
（`balance`，无百分比），路由按余额称重。

### 签到

ModelScope 没有签到接口。`GET /api/v1/users/login/info` 本身就是一次网页登录，
服务端把它算作当天签到并发放（`daily_active` 200 + 绑定阿里云 50），一天一次。
所以流程是：

1. 先读当日账单 —— 已有发放行 → `done`（不是虚假的 `claimed`）
2. 没有 → 用网页会话（`Cookie: m_session_id=<token>`）碰一次 `login/info`
3. 再读账单核对 → 有新增发放行 → `claimed`（带上到账魔粒数）
4. 账本读得到但今天没有发放行 → `inactive`（"登录已触达，但今天没有到账记录"）
5. 账本压根读不到 → `failed`（宿主半小时后重试）

magpie 自己按「每个账号每个北京日一次、失败半小时后重问」调度，插件不加节流，
也不处理验证码（遇到风控 403 会说清楚，不会假称签到成功）。

### 账号名

`api` 类型的登录只有一把 key，magpie 默认显示成 `API key …a1b2`。读到站点用户名
后用 `client.auth.set` 写回账号：优先官方 `/openapi/v1/users/me`（Bearer，无副作用），
它答不出时才碰 `login/info`（那个接口会顺带签到，不能当普通查询用）。

---

## 与上游两个插件的差别

| | msmoli | ms-ai | 本插件 |
| --- | --- | --- | --- |
| 国内站调用模型 | ❌（说聊天交给内置 `modelscope` 预设） | ❌ | ✅ |
| 国际站调用模型 | ❌ | ✅ | ✅ |
| 国内站签到 / 余额 | ✅ | ❌ | ✅ |
| 国际站签到 / 余额 | ✅ | ✅ | ✅ |
| 签到时段窗口（默认 08:30–10:00 才领） | ✅ 配置文件可调 | ❌ | ❌ 交给 magpie 的 CheckinAt |
| 连签天数 streak | ✅ | ❌ | ❌ |
| 体积 | 4354 行（大量脱敏/探测加固） | 1070 行 | 约 900 行 |

脱敏那套（令牌回声、代理页面、乱码截断等）本插件没有搬：它服务的是「卡片和
日志里不出现令牌」。本插件的报错只带 HTTP 状态和厂商消息，不拼 token 原文，
所以那套机器在这里没有用武之地。

## 选项

没有插件级开关。站点地址与 API 地址可以用环境变量盖掉（测试或自建网关）：

| 环境变量 | 作用 |
| --- | --- |
| `MODELSCOPE_CN_API_BASE` | 国内站 API-Inference 地址 |
| `MODELSCOPE_CN_SITE_URL` | 国内站网页接口地址 |
| `MODELSCOPE_AI_API_BASE` | 国际站 API-Inference 地址 |
| `MODELSCOPE_AI_SITE_URL` | 国际站网页接口地址 |

## 测试

```powershell
cd D:\magpie-plugin\magpie-modelscope-hub
node --test
```

19 个用例：17 个单元（北京时间换算、账单汇总与额度分桶、用量卡三种形态、模型
条目形态与 deprecated 判定、推理强度覆盖、图片与多模态能力、两个 provider 的钩子形状）+ 2 个端到端
（起一个本地假站点，跑通「签到 → 到账 → 用量卡 → 模型列表」和「401 标记过期」
两条链路，不联外网、不碰真令牌）。

## 从上游插件切换过来

`magpie-plugin-msmoli` 可以与本插件并存，但两边都会去签同一个账号：

```powershell
magpie plugin rm magpie-plugin-msmoli     # 或先留着，等新插件登录验证完再删
magpie plugin login modelscope-cn         # 用同一把 ms- 令牌登一次
```

本插件的账号和上游不共享：`plugin-auth.json` 里的登录按 provider id 存，
`msmoli` 的登录不会自动变成 `modelscope-cn` 的。令牌是同一个，重新登一次即可。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| 卡片显示「令牌失效，或不是国际站 modelscope.ai 的令牌」 | 令牌登错了站：国内站令牌要登 `modelscope-cn` |
| 卡片只有「合计 230 可用」，没有今日发放 | 账单读不到（403 风控 / 网络），余额是好的 |
| 签到报「被魔搭风控拒绝（HTTP 403）」 | 站点风控；`failed` 会半小时后重试，别频繁手动点 |
| 模型列表只有 3 个（国际站）/ 7 个（国内站） | `/models` 没拉到，正在用内置兜底，不是故障 |

## 不做的事

- 不自动注册账号、不绕过验证码、不破解风控
- 不读取或修改其他插件的凭据
- 不把 `/v1/models` 的条目当成「一定能调用」的证明（国际站那份黑名单就是实测出来的反例）
