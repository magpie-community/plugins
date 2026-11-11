# magpie-credit-limit

给 [magpie](https://usemagpie.com) 的网关加**每日积分限额**：按渠道、甚至按账号设额度，用上游真实的积分消耗判定，超了就停用账号 / 下架渠道，第二天自动装回。外加两条「按预算排座」的路由策略和一道「发出去之前就拦住」的请求闸门。

> 原名 `magpie-plugin-budget`。改名是因为叫 budget 的插件太多，加上「credit（积分）」更说明它管的是**积分**限额而不是通用预算。

装在 magpie 里之后，可以在**任何**路由选择器里选到：

- `credit-limit/quota-first` —— 额度快 **到期** 的账号先用（不用就白白清零），某个账号用到 `ceiling`% 就换下一个
- `credit-limit/token-spread` —— 近一小时被用得最少的账号先上，别逮着一个账号猛打

以及一道请求闸门 `onRequest`：命中黑名单的模型 / agent、或者一次请求的文本太长，**在路由之前**就拒掉，不花那份钱。

安装方式（本地路径原地加载，不复制；`<插件目录>` 换成你放这个仓库的路径）：

```json
{ "plugins": [ { "spec": "<插件目录>" } ] }
```

命令行加也行：

```sh
magpie plugin add "<插件目录>"
```

确认 magpie 认出来了（**这一行就是它真的加载成功的证明**）：

```
$ magpie plugin list
<插件目录>  on
  gateway middleware  onRequest · routings magpie-credit-limit/quota-first, magpie-credit-limit/token-spread
```

> 也可以从 GitHub 直接装：`magpie plugin add github:R227BOUT/magpie-credit-limit`。

---

## 一、装上就能用：额度检查是插件自己跑的

**不需要开命令行，不需要配计划任务，不需要另外装看门狗。**

插件的主入口（`package.json` 的 `main`）由 magpie 自己的 bun 进程加载并常驻，所以它自己能：

| 需要的能力 | 插件主入口有没有 | 实测 |
| --- | --- | --- |
| 读文件（`logins.json` / `providers.json` / `usage.jsonl` / `quotas.json`） | ✅ | 有 `node:fs` |
| 写文件（关账号、下架渠道） | ✅ | 同上 |
| 起定时器（每 N 分钟查一次） | ✅ | 进程常驻，`setInterval` 一直跑 |
| 起子进程 | ✅ | 有 `node:child_process` |

所以整套判定和执行都在插件内部完成：装上 → 打开「让额度真正生效」→ 就这样。

> ⚠️ 曾经踩过的坑：**中间件（`budget.middleware.js`）确实做不到**——它跑在 moejs 沙盒里，只有 `console`，没有 fs、不能 import、每个请求独立运行时。但**主入口不是中间件**，两者能力完全不同。把「插件层做不到硬停」当成结论是错的，漏看了 `main` 这条路径。

### 真正卡住的是哪一层

| 需求 | 能不能做 | 靠谁 |
| --- | --- | --- |
| 跨请求累计用量 | ✅ | 插件主入口读 `usage.jsonl` / `quotas.json` |
| 超了要**拒绝/停用** | ✅ | 写 `logins.json`（停账号）或 `providers.json`（下架渠道） |
| 定时复查 | ✅ | 主入口的 `setInterval` |
| 按账号看用量 | ✅ | `quotas.json` 的 key 就是 `<渠道>/<账号>` |

唯一的限制是**响应速度**：定时器最短 30 秒一轮，所以是「几分钟内拦住」，不是「这一笔就拦」。要毫秒级得靠 magpie 核心的 `caller-keys.json` 预算（按调用方密钥，不按上游渠道）。

---

## 一点五、"积分"到底从哪来（三级优先）

magpie 的账本（`usage.jsonl`）**只记 token 不记积分**，所以"今天花了多少分"得自己想办法。这里按可信度从高到低取，取到就用，取不到才往下退：

| 级别 | 来源 | 怎么用 | 准不准 |
| --- | --- | --- | --- |
| 1 | `credits-daily.json` | 上游按天记的消耗，直接读 `days[今天]`，或窗口恰好是今天时读 `last.used` | **最准**，就是上游自己记的数 |
| 2 | `quotas.json` | 用「当天首见余额 − 当前余额」算差值 | 准，但依赖跨天基准接续 |
| 3 | `usage.jsonl` | token ÷ 换算率（每渠道一个 `tokensPerCredit`） | **估算**，只在前两条都没有时兜底 |

**第 2 级以前有个洞**：如果插件/进程在当天中途重启，基准会被重置成"重启那一刻的余额"，前面已经花掉的部分凭空消失——重启越多次，实际能超得越多。现在跨天用 `rollBase()` 把昨天最后一次读数接上当新基准，堵上了。

**第 3 级的换算率默认值**（1 积分 = N token），来自 LMR 猎模人账本近 30 天实测回归：

| 渠道 | 换算率 | 样本 |
| --- | --- | --- |
| loomy | 9,666 | 8,088 条 |
| autoclaw | 11,373 | 1,101 条 |
| raccoon | 25,700 | 323 条 |
| officeace | 39,000 | 765 条 |
| workbuddy | 23,804 | 9 条 |
| workbuddy-ai | 15,338 | 4 条 |

> ⚠️ **其余渠道的 10000 是占位猜测，不是测出来的。** 面板上会明确标「无来源」。建议按各家的官方口径改，改写进 `dailyCredits` 的 `<渠道>:tpc`。
>
> 两条统计口径上的坑：① 必须**只取 `credit >= 1`** 的记录，积分上报精确到 0.01，小请求会四舍五入成 0，混进来能把均值带偏 20 倍；② `credit` 为 NULL/0 是**「没采集到」不是「免费」**，当 0 放进分母会把换算率算得明显偏低（autoclaw 曾因此被算成 1,900，只有真实值的六分之一）。

**多积分包不能无脑相加**：有的渠道会同时给一个「总」包和它的子包（codearts 的「总积分」=「基础积分包」+「赠送积分包」），三个一起加就是双倍。所以名字里带「总 / total / 合计」的包优先，有它就只用它。
这是启发式，不是上游保证的口径——换成别的渠道如果发现加错了，按 `credits-daily.json` 里实际的包名调。

---

## 二、那现在能拿到的"限额"是什么

**「花到 80% 就换人」**——这就是 magpie 能给的、真正生效的限额。做法是让请求**在多个供应商之间轮换**，而不是打死一家。

### 配方：建一个跨供应商的组，用 `credit-limit/quota-first`

1. magpie → **提供商** → 新建一个组（比如叫 `budget`）
2. 把你想共享额度的模型都塞进去，例如：
   `workbuddy/hy3`、`teleagent/chat-pro`、`dumate/...`、`codearts/deepseek-v4.1-flash`
3. 这个组的**路由**选 `credit-limit/quota-first`
4. 把这个组设成你 agent 用的模型

效果：

- 哪个账号的额度**先到期**，就先用它 → 避免"周四重置、周三还剩一半"的浪费
- 哪个账号用到 `ceiling`%（默认 80）→ 自动跳到下一个
- 所有账号都过 80% 了 → 回到"最早到期的最先上"，不会卡死

**注意**：如果这个池子（provider 或组）里只有一个账号，策略没有任何可换的对象，顺序等于原样——这是数学问题，不是 bug。所以必须**至少两个成员**才有效果。

---

## 三、两道闸门：发出去之前先拦

```json
{
  "block": {
    "models": ["gpt-6-astra", "gpt-6-*"],
    "agents": ["cursor"]
  },
  "maxRequestTokens": 200000,
  "estimate": 3
}
```

| 选项 | 作用 |
| --- | --- |
| `block.models` | 模型名命中就拒（403）。支持 `*` 通配，不区分大小写；`.` 是普通字符，不是正则 |
| `block.agents` | agent 名命中就拒（403）。适合"别让某个 agent 用我的 magpie" |
| `maxRequestTokens` | 一次请求的**文本字符数 ÷ `estimate`** 超过它，就拒（413）。0 = 不限 |
| `estimate` | 多少字符算一个 token，默认 `3`（中文约 1.5~2，英文约 4，取 3 偏保守） |

计数把 `messages`、`system`、`tools` 的 schema、Gemini 的 `parts` 全算进去——**它们都会被发出去并计费**，不是只有你打的那句话。

> `maxRequestTokens` 只限制**单次**请求的大小，不累计。它的用处是"别让 agent 一次贴 20 万字的文件，一把烧掉一大截额度"。

在 magpie 的 **设置 → 插件 → magpie-credit-limit → 「积分限额」面板**里改（不用碰 JSON，见下一节），改完下次请求就生效（网关每秒重读一次）。

---

## 三点五、设置里的「积分限额」面板

装好后，magpie 的 **设置** 页多一个 **「积分限额」** 面板（这是 magpie 的原生插件面板机制，不是外挂网页）：

- **每个渠道一张卡**：填每日额度（积分）和换算率（1 积分 = 多少 token）
- **卡上有「预估能跑」列**：额度 × 换算率，填完不用保存就能看到这个额度大概能跑多少 token，改数字实时变
- **右上角徽章**显示这个渠道每天能用多少 token
- **多账号区一个开关**：渠道额度按账号平摊
- **下面一排闸门输入框**：单请求上限、字符/token 比、额度让位线

保存的数全部落在这个插件自己的 options 里（plugins.json 的 `Entry.Options`），**网关中间件读的就是同一份**——面板里改，下一个请求就按新的拦。不需要重启，不需要碰文件。

### 换算率是怎么来的（重要）

「1 积分 = 多少 token」这个数决定了「预估能跑」准不准，所以把来源说清楚：**只有 6 个渠道是实测的，其余都是占位猜测。**

实测的 6 个，来自 `LMR猎模人/开发版/data/usage.db` 的 logs 表（17,709 条真实调用），按渠道汇总 `total_tokens / credit`：

| 渠道 | 样本 | 换算率 |
|---|---|---|
| loomy | 8,088 条 | 9,666 |
| autoclaw | 1,101 条 | 11,373 |
| officeace | 765 条 | 39,000 |
| raccoon | 323 条 | 25,700 |
| workbuddy | 9 条 | 23,804 |
| workbuddy-ai | 4 条 | 15,338 |

统计时有两个必须注意的地方：

1. **只取 `credit >= 1` 的记录**。积分上报精确到 0.01，小请求会被记成 0.01 → `40 tok ÷ 0.01 分 = 4,000`，这种噪声能把均值带偏几十倍。
2. **`credit` 为空或 0 是「没采集到」，不是「免费」**。当成 0 放进分母，算出来的换算率会明显偏低——早期就是因此把 autoclaw 算成了 1,900，只有真实值的六分之一。

**其余渠道的 10000 是猜的**，不是测出来的：它约等于 loomy 的实测值，纯粹为了界面上有个能算的数。用这些渠道前，请按官方口径改成真实值，或者干脆别给它开额度——否则「预估能跑」会显示一个没有依据的数字。

### 多账号：可以按账号分别设额度

**能分，而且是推荐做法。** 展开渠道卡上的「按账号设额度」，每个账号一行，各自填额度、各自看预估。

难点只有一个：**面板拿不到账号名单**。magpie 只允许面板读两样东西，都不给账号：

| 读的东西 | 给什么 | 给账号吗 |
|---|---|---|
| `providers:list` | 渠道 id 和名字 | **不给**（源码注释原话：`no key, no account, no address`） |
| `usage:summary` | 总量 + Top20 模型 | **不给**（测试里明确断言不许返回 `accounts`） |

但**插件主入口是普通进程，能读 `logins.json`**。所以它每轮检查时顺手把名单写进插件自己的 options（`options.accountsByChannel`），面板用 `magpie.options.get()` 就读到了。

**你不用做任何事**——装上、等第一轮检查跑完（约 5 秒），面板上就会出现账号行。

只写能认人的字段：渠道、账号名、是否启用、套餐。**不写 token / cookie / home**，测试里有硬断言守着。

额度键就是 `渠道/账号`：

```json
{
  "dailyCredits": {
    "loomy": 500,
    "loomy/138****0001": 200,
    "loomy/139****0002": 300
  }
}
```

账号级优先于渠道级：填了账号额度，这个账号就只按它算；没填就跟渠道额度走（界面上会标「跟随渠道」）。

### 平摊开关（懒得逐个填时用）

如果一个渠道有 5 个账号，逐个填太麻烦，可以打开 **「渠道额度按账号平摊」**：

```
关（默认）：渠道额度 = 所有账号加起来的上限，到顶就整个渠道摘掉
开　　　　：渠道额度 = 总额度，每个账号分到 总额度 ÷ 启用账号数
```

比如两个账号、额度填 **200**，开了平摊 → 各 **100**。A 跑满就只停 A，B 继续用，渠道本身不摘。

三条细节：

1. **只对多账号渠道生效**。单账号没有"分摊"可言，仍按渠道级判定。
2. **账号额度优先**。显式写了 `"loomy/某账号": 500`，就取它和平摊份额里**小的那个**。
3. **平摊时渠道不因"合计到顶"被摘**。否则两个账号一共用到 200 就把渠道整个下架，平摊就白做了。只有合计超过总额度 2% 以上（说明有拦不住的账号）才兜底摘渠道。

## 四、参数与默认值

```json
{
  "ceiling": 80,
  "maxRequestTokens": 0,
  "estimate": 3,
  "block": { "models": [], "agents": [] }
}
```

- `ceiling`：额度用到百分之几就"让位"。`1` 表示"用过一次就换"，`100` 表示"只有真的用光才换"。默认 80。
- 其余见上表。

选项写坏了（不是对象、类型不对、通配符非法）不会炸：读不懂的那一项按默认处理，请求照常走。**这道闸门永远不会因为自己出错而拦掉你的请求**——这是刻意的，见 `budget.middleware.js` 里 `number()` / `globToRegExp()` 的写法。

---

## 五、测试

```sh
node test/run.mjs
```

36 个用例，全部按 magpie 网关真实的调用契约跑（`ctx` 的字段、`body` 是已解析的对象、策略要返回 seat 索引的排列）：

- `test/cases.mjs` —— 闸门的 19 个用例（该拒的拒、不该拒的必须原样通过）
- `test/strategies.json` —— 两个策略的 14 个排序用例
- 外加两个结构性断言：任何选项组合下，策略都必须返回**合法排列**（少一个 seat 就会让 magpie 退回原始顺序，等于静默失效）；策略名必须符合 magpie 对路由名的正则

**变异验证**（改坏代码看测试会不会红，确认不是假绿）：

| 改坏什么 | 结果 |
| --- | --- |
| `403` 改成 `400` | 5 fail |
| `used >= ceiling` 改成 `>` | 1 fail |
| 去掉 `resting` 层级 | 2 fail |
| 不检查 `maxRequestTokens` | 4 fail |
| 恢复 | 36 pass / 0 fail |

---

## 六、许可

MIT。

---

## English

Two budget-aware routings for magpie's gateway, plus a per-request gate.

- `credit-limit/quota-first` — fill each seat up to `ceiling` percent, the window renewing soonest first, so an allowance that would reset unspent is spent first.
- `credit-limit/token-spread` — the seat magpie used least in the last hour goes first.
- `onRequest` — turns away a request for a blocked model or agent, or one longer than `maxRequestTokens`, before it is routed and paid for.

**What it cannot do:** stop a provider once a running daily total crosses a budget. A gateway middleware runs each request in a pooled runtime with no filesystem, and the only runtime whose counters survive across requests is the one that cannot reject. That needs core support; a plugin can only reorder seats. With a single seat in a pool there is nothing to reorder to — use a group of two or more providers.
