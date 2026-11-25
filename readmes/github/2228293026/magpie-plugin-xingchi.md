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

#### 会话轮次限制

插件根据上游反馈动态学习会话上限，不固定为 20 或 100 轮：

- 上限未知或缓存过期时，发送原始历史。收到明确的 `session_turn_limit_exceeded` 后，
  从结构化字段或中英文错误消息读取轮数，按新值封装原始历史并重试一次。
- 观察值按实际网关、API key 和模型隔离，分组切换使用该组的 key。
  缓存存放在 Magpie 配置目录的 `xingchi-turn-limits.json` 中，只包含密钥等信息的
  SHA-256 组合哈希、轮数和观察时间，不包含 API key 原文。
- 缓存有效期为一小时，成功请求不会延长有效期。上限降低时，新的超限错误立即更新缓存；
  上限提高时，缓存到期后重新发送原始历史，直到触及新的上限。这些请求也是实际业务请求，
  不另外发送探测请求。
- UA 回退和轮次超限各最多重试一次；额度、限流、上下文 token 超限、网络和普通上游错误
  保留其原有失败结果。错误中没有可用轮数时不猜测上限。
- 流式请求只预读至首个输出事件，最多等待一秒、检查 64 KiB。开头的明确超限可以重试；
  流已经开始转发后，只更新下一次请求的观察值，保留当前的失败事件，不重放已输出的内容或工具调用。

**用户轮次和模型回复次数是两种限制。** 上游除了按 user 消息数计算的轮次，还会限制一次请求里
模型已经回复的次数，例如“当前会话模型已回复 105 轮”。后者在一条用户任务内连续调用工具时也会
触发，只数 user 消息会漏掉。插件对两者分别处理：

- 两种观察值分别缓存，互不覆盖。用户轮次的上限照上文的规则学习。
- 模型回复的反馈只有给出明确上限时才当作上限；只说“已回复 N 轮”时，N 是被拒绝时的次数，
  不是上限。插件把保留的原生模型条目减到 N 与本次已发送条目两者较小值的一半，再重试一次。
  这是有余量的预算，不是对上游上限的断言。
- 原生模型条目保守地统计助手消息、推理条目、各类工具调用和条目引用，工具结果不重复计算。
  超过预算时，把较早的已完成步骤连同工具结果封装为原文 JSON，可以在同一条用户任务内切分；
  推理条目和同一响应里的工具调用保持在同一侧，未完成的调用和跨边界的引用继续保留为原生条目。
- 同一通道并发返回多个反馈时取较小的预算，迟到的较大数字不会把它抬高；预算同样一小时后过期。

2026-11-25 13:05–13:07（北京时间），通过正在运行的 Magpie 网关验证上述模型回复限制。
每个请求带两条 user 消息，中间是已完成的工具调用及结果：

| 经 Magpie 网关发送的历史 | 结果 |
| --- | --- |
| 105 次工具调用，流式，该账号尚无模型预算 | 首次被 HTTP 400 拒绝并报告 100 轮；重试发送 50 次原生调用，HTTP 200、`completed` |
| 205 次工具调用，普通 | 命中预算，直接发送 50 次原生调用，HTTP 200、`completed` |
| 105 次工具调用，流式 | HTTP 200、`completed`，收到 `response.completed` |
| 105 次工具调用，普通 | HTTP 200、`completed` |

四项都正确读回随机项目标记、用户纠正后的 `retry_limit=7`、任务值和最后一条工具结果里的步骤号
（105 或 205），没有产生新的工具调用。用量记录确认服务商为 `xingchi`、实际服务模型为
`gpt-6.1-sol`。直接调用星驰接口的对照也得到相同结果。

这次改动前的验证没有覆盖工具调用密集的历史。同日 12:04–12:15 的两次网关流式测试曾分别
在 60 秒后由客户端取消、在 112 秒后返回 `upstream_error: Unable to forward upstream stream`；
同一账号直连以及通过插件加载器的流式请求当时都正常。之后四次网关流式请求均正常完成，
但前两次失败的原因没有确定，不能排除上游通道偶发失败。

当前离线验证为 **181 项测试、661 个断言全部通过**，新增覆盖模型回复计数、同一用户任务内的
合并、推理与工具调用的边界、并发反馈和读取期间的过期变化。下列较早测试保留作对照。

2026-11-25 05:11–05:15（北京时间），动态机制完成后，重新验证真实星驰接口和正在运行的
Magpie 网关。直接接口测试使用第 3 分组的 `gpt-6.1-sol`；Magpie 测试使用
`http://127.0.0.1:3425/v1/responses` 和 `xingchi/gpt-6.1-sol`：

| 验证场景 | 结果 |
| --- | --- |
| 隔离缓存预置旧上限 100，直接通过插件发送 21 轮 | 上游先收到 21 条 user，返回 HTTP 400 并明确报告上限 20；插件学习新值，重试发送 16 条 user，HTTP 200、`completed` |
| 重新创建插件，读取上述持久缓存，发送 21 轮 | 只向上游发送一次请求，HTTP 200、`completed` |
| 直接通过插件发送 21 轮流式请求 | 只向上游发送一次请求，正常收到 `response.completed` |
| 经运行中的 Magpie 发送 21 轮普通请求，测试前缓存为空 | HTTP 200、`completed`，生成有效的 20 轮观察值 |
| 经运行中的 Magpie 发送 101 轮普通请求 | HTTP 200、`completed` |
| 经运行中的 Magpie 发送 21 轮流式请求 | HTTP 200，正常收到 `response.completed` |

六项均正确读回首轮的随机项目标记、用户纠正后的 `retry_limit=7` 和精确任务值
`remaining_task="update README"`。各组后续成功请求没有延长首次观察时间，缓存检查未发现 API key 原文。
Magpie 三项的响应头及对应的用量记录均确认服务商为 `xingchi`，请求模型为
`xingchi/gpt-6.1-sol`，实际服务模型为 `gpt-6.1-sol`。本机使用本项目目录作为本地插件，
测试时插件宿主的启动时间晚于所有提供商运行模块的修改时间，确认运行服务已加载新代码。

该次离线验证为 **154 项测试、576 个断言全部通过**，覆盖上限降低、缓存过期后提高上限、
账号／分组／模型／网关隔离、工具边界及流式错误；独立 CLI 预览也验证了自定义网关的
100 轮观察值对应 95 回合阈值。下列较早测试保留作原生边界及历史处理方式的对照。

2026-11-25 03:06–03:11（北京时间），用本机已登录账号的第 3 分组向真实网关发送
`gpt-6.1-sol` 请求，确认该通道当前上限为 **20 轮**：

| 请求 | 实际发送的 user 消息数 | 结果 |
| --- | --- | --- |
| 原生 20 轮历史，`store: false`，不带 `previous_response_id` | 20 | HTTP 200，`completed`，回复 `OK` |
| 原生 21 轮历史，同样关闭 store 且不带响应链 | 21 | HTTP 400，`session_turn_limit_exceeded`，错误明确写着“已满 20 轮” |
| 通过当时源码的插件 loader 发送 21 轮历史 | 16 | 普通和流式请求复测均为 HTTP 200、`completed`；流式收到 `response.completed` |
| 通过插件 loader 发送 101 轮历史 | 16 | HTTP 200，`completed` |

这次边界测试检查的是单次请求携带的历史轮数。封装后的 21／101 轮请求都正确读回了
首轮的随机项目标记、早期用户纠正后的 `retry_limit=7` 和未完成任务 `update README`；
原生 20 轮及原生 16 轮对照也读回了相同内容。

初次封装 21 轮的普通请求返回 `upstream_error: Upstream request failed`，初次流式请求
收到 `response.failed: Unable to forward upstream stream`；复测相同请求后均通过。
这些失败也计入实测记录，封装不保证上游通道始终可用。
第 4 分组的模型清单可读取，但请求返回 HTTP 403、`insufficient dedicated balance for this group`，
因此本次没有验证该分组的轮次上限。

2026-11-25 03:24–03:27（北京时间），补充通过正在运行的 Magpie 网关验证。
本机 Magpie 已将本项目目录登记为本地插件，测试实际调用
`http://127.0.0.1:3425/v1/responses`，模型为 `xingchi/gpt-6.1-sol`：

| 经 Magpie 网关发送的历史 | 结果 |
| --- | --- |
| 21 轮，普通响应 | HTTP 200，`completed`，早期项目标记和纠正后的值正确 |
| 21 轮，流式响应 | HTTP 200，收到 `response.completed`，项目标记、纠正值及待办正确 |
| 101 轮，普通响应 | HTTP 200，`completed`，项目标记、纠正值及待办正确 |

三项均首次通过。响应头确认 `x-magpie-provider: xingchi` 和
`x-magpie-model: xingchi/gpt-6.1-sol`；对应的 Magpie 用量记录也确认实际服务商为
`xingchi`、所请求及实际服务的模型为 `gpt-6.1-sol`。
前一组实测直接加载源码并访问星驰，本组验证经过了 Magpie 正在运行的服务。

不同模型和分组的实际限制以上游返回为准；该次实测的 20 轮是通道当时的观察值。
以下 100 轮数据是旧版通道的历史实测，不能据此判断当前上限。

2026-11-21 19:59–20:00（北京时间），绕过插件直接向星驰的 `/v1/responses`
发送 `gpt-6.1-sol` 请求，使用 `store: false`，不带 `previous_response_id`，实测结果为：

| 请求历史 | 结果 |
| --- | --- |
| 99 条 user、98 条 assistant | HTTP 200，`completed`，回复 `OK` |
| 100 条 user、99 条 assistant | HTTP 200，`completed`，回复 `OK` |
| 101 条 user、100 条 assistant | HTTP 400，`session_turn_limit_exceeded` |

101 轮请求的上游错误内容为：

> 当前会话已满 100 轮对话，请新开一个会话继续（Codex 输入 /new，其他客户端新建对话）。
> This conversation has reached 100 turns. Please start a new session to continue.

因此当时实测通道存在 **100 轮检测**，`store: false` 和完整历史重放也会触发。
上述测试检查的是请求体携带的历史轮数，没有连续发送 101 次请求。
同日 17:34–18:27 的历史请求记录曾出现“已满 10 轮”的错误，不能用该旧值代表当前状态；
也不能将这次历史实测结果推广到所有模型和分组。

**API 调用次数与历史轮数不同。** 一次用户任务中的多次工具调用可能产生很多模型请求，
而请求中的 user 消息数量不随每次工具调用增加；客户端压缩历史后，后续请求携带的历史
也会改变。因此同一客户端会话可以累计数百次 API 请求，不能据此判断请求历史已超过轮数上限。

当 Responses 的 `input` 超过当前通道的**已观察上限**时，插件合并旧历史：

- 最近的原生轮数为“已观察上限减 5”，至少保留一轮；更早的消息以带原始角色和字段的
  JSON 封装为一条历史消息，不生成摘要、不删减原文。上限为 20 时，最近 **15 轮**原生，
  通常合并成 **16 条 user 消息**；上限为 10 时通常合并成 6 条，上限为 100 时通常合并成 96 条。
  工具依赖可能使原生历史保留更多轮，只有合并后不超过实际观察上限时才发送封装。
- 最近的工具调用与结果保持原格式。跨越边界的工具引用会连同原始调用保留；若无法找到
  能减少轮数的安全边界，保持原请求，避免拆开未完成的工具链。
- 旧图片、文件、音频继续作为原生附件发送，历史 JSON 用编号关联它们。
- 封装说明明确要求按原始角色和时间顺序阅读，延续尚有效的用户约束、纠正记录与未完成任务；
  区分助手陈述、工具证据和当前指令，保留精确路径、代码与数值，避免重复执行已经完成的工具调用。
- 此操作改变旧历史的消息结构，不减少其 token 占用，也不提高模型上下文窗口。
- 旧版按 100／95 轮生成的封装也会继续合并，展开原有历史并保留原文，避免嵌套 JSON。

2026-11-21 20:45（北京时间），旧版按 100／95 轮规则将 101 轮历史发送为 96 条 user 消息，
实测返回 HTTP 200、`completed`；模型能读回第一条旧消息的原文标记，
也能同时读出近期原生工具调用的结果。

20:54–20:55 的补充对照中，原生 100 轮和带详细封装说明的 101 轮请求均正确返回相同的
项目标识、早期纠正后的数值、旧工具测试结果、近期工具结果和最新待办，且没有重新调用
已完成的工具。这是有限场景的语义验证，封装仍会改变旧历史的消息结构。

可在下文的 Magpie 插件选项中把 `historyPacking` 改为 `false`，关闭历史合并。
关闭后或遇到无法安全合并的历史时，若上游仍报轮次超限，按提示新建会话。

#### Codex 自动续接（可选）

打开 **插件 → 已安装 → 星驰 Xingchi → 选项**。如果有多份星驰插件，选 Magpie 正在使用的那份；
使用下方钩子时，脚本也应来自同一份以本地绝对路径登记的插件。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `historyPacking` | `true` | 在原会话内合并较早的原文；无需 Codex 钩子。 |
| `codexAutoHandoff` | `false` | 通过下方的 Codex 钩子自动创建续接会话。 |
| `codexAutoOpen` | `true` | 交接完成后在 Codex 桌面端打开新会话；仅在自动续接开启时作用。 |

如果选项显示为 JSON 编辑框，修改对应的 `true` / `false` 后点击 **保存**，其余字段保持原样。
只用原文封装时，将 `codexAutoHandoff` 设为 `false`，自动创建和跳转都会停止；
想自动创建但不跳转时，将 `codexAutoOpen` 设为 `false`。
如果通过命令行修改了选项，而 Magpie 界面仍显示旧值，请先刷新插件页再查看，避免把旧值重新保存。

1. 确认本机能运行 `node` 和支持 `app-server`、`Stop` 钩子的 `codex`。
2. 将 [示例](examples/codex-handoff.hooks.json) 的 `Stop` 条目合并进 Codex 的 `hooks.json`
   （默认 `~/.codex/hooks.json`），保留已有钩子，并把脚本路径改成实际的绝对路径。示例的 `--all-projects`
   覆盖所有通过 Magpie 使用 `xingchi/` 模型的本机 Codex 会话，包括其他项目和 Git worktree。
   如需限制在单个目录，把 `--all-projects` 换成该目录的绝对路径。重新打开 Codex，并在钩子管理界面审核此命令。
3. 在 Magpie 中保存 `codexAutoHandoff: true`。示例中的 `magpie` 模式会在每次运行时读取插件的已保存选项，
   之后把它改回 `false` 即可停止续接，无需删除钩子。用非默认 Magpie 数据目录时，
   可用环境变量 `XINGCHI_MAGPIE_PLUGINS_FILE` 指向其中的 `plugins.json`。
   也可独立运行：`preview` 只提示，`auto` 直接续接，`off` 停用；独立模式不受 Magpie 开关控制，
   但 `preview` 和 `auto` 仍读取已保存的网关地址，以匹配对应的上限缓存。

钩子读取同一缓存中当前模型、分组及已登录账号的有效观察值，取其中较小的上限。
没有观察值时不自动创建会话。它按本地 Codex 用户回合计数，阈值为“已观察上限减 5”，
至少为 2，避免交接自身的第一轮再次触发交接；上限为 1 时不自动续接。
例如上限为 20 时，达到 15 回合后，在回复结束时创建一个新的
Codex 会话，沿用当前会话的工作目录和 Magpie 模型路由，发出一条带交接资料的消息。新会话以只读权限启动，
交接回复只整理状态并等待下一条用户指令。交接完成后，标题会设为 `星驰续接 · YYYY-MM-DD HH:mm:ss`
（北京时间），脚本会请求 Codex 桌面端打开新会话。若只想创建，可关闭 `codexAutoOpen`，或在钩子命令末尾加 `--no-open`。
没有桌面端或打不开时，仍可执行提示中的 `codex resume <会话ID>`。需要编辑文件时，在新会话中选择相应权限。

交接会把旧会话的首轮需求、部分较早的用户要求和最近四轮的文本摘录发给同一模型，以保留约束与任务状态。
旧会话及其已有的本地记录不会被修改、归档或删除。新会话只带文字摘录，图片、工具原始输出和未选中的历史不会自动带入。
续接阈值随观察值变化，仍是本地触发点，不等同于请求体实际携带的历史轮数。
每个旧会话最多尝试创建一次，即使等待超时也不会另建重复会话。如果提示失败，可先查看提示中的新会话 ID；
必要时在核实没有新会话后，删除 Codex 配置目录下 `xingchi-handoff/<旧会话ID>.txt` 以允许重试。

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
同名模型在不同分组中使用各自的 key 分别探测，工具能力同时同步到宿主读取的能力字段。

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

**全部 16 个静态兜底模型**的上下文/输出值已按上游目录 [`models.dev/api.json`](https://models.dev/api.json)（2026-11-20）同步。
`gpt-5.6-*`、`gpt-6-sol/luna/astra`、`gpt-6.1-*`、`gpt-5.5`、`gpt-5.4` 为 1050000/128000；
`gpt-6` 沿用 `gpt-6-astra` 别名规格；`gpt-5.4-mini` 与 `gpt-5.2` 为 400000/128000；
`gpt-5.3-codex-spark` 为 128000/32000。`codex-auto-review` 无上游目录条目，保留 128000/32768 兜底。

**GPT-6.1 Sol 总上下文为 1050000 tokens，最大输出为 128000。**输出额度包含在总窗口中。
星驰这把 Key 的模型专属 Codex 清单另报 `context_window: 500000`、`max_context_window: 872000`；
普通 `/v1/models` 不返回该信息。客户端配置采用所选的模型 API 窗口，不代表星驰每个上游渠道均已实测支持完整 1050000。

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
bun test                                        # 离线：协议、动态上限、历史合并、流式错误、续接、认证、签到及冒烟判定
XINGCHI_API_KEY=sk-… bun run scripts/smoke.mjs   # 打真实网关
```
