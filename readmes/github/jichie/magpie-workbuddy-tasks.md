# magpie-workbuddy-tasks

把 WorkBuddy **国内版**的日常收益做成一个 magpie 插件：复用你在 magpie 里**已经登录**的账号，批量完成成长任务、微信小程序链式任务、猫猫旅行、夜猫子、Buddy 盲盒与连登管家（补签 / 档位兑换 / 抽奖 / 礼包），并顺手收好每日活跃与积分查询。自带本地看板、北京时间小时排程和 7 个 MCP 工具；**不需要、也不接受任何密钥**，不声明 provider、不碰对话链路。

- 仓库：<https://github.com/jichie/magpie-workbuddy-tasks>
- 安装：`magpie plugin add github:jichie/magpie-workbuddy-tasks`
- 当前版本：**0.3.4**（[更新日志](./CHANGELOG.md)）
- 只服务国内版 `workbuddy` **个人版**账号；国际版 `workbuddy-ai` 与企业版（`enterpriseId`）都不会出现在插件里（企业版没有成长任务与签到，只留一行忽略计数）。

> 只做「收益自动化」：不伪造无法自动化的任务、不代理对话、不采集任何遥测。看板与 API 只在你本机（或你自觉暴露的局域网）里。

## 目录

- [快速开始](#快速开始) · [账号导入 / 导出](#账号导入--导出可直接同步进-magpie) · [它做什么](#它做什么) · [看板里有什么](#看板里有什么)
- [它刻意不做什么](#它刻意不做什么) · [账号复用与 token 回写](#账号复用与-token-回写) · [安装](#安装) · [智能体工具](#智能体工具mcp) · [HTTP API](#http-api)
- [排程与时间口径](#排程与时间口径) · [数据与隐私](#数据与隐私) · [看板与局域网安全](#看板与局域网安全) · [生命周期](#生命周期) · [状态文件](#状态文件)
- [故障排查](#故障排查) · [目录与测试](#目录与测试) · [更新日志](#更新日志) · [来源与致谢](#来源与致谢) · [许可](#许可)

## 快速开始

1. 在已登录 WorkBuddy 国内版的 magpie 上执行 `magpie plugin add github:jichie/magpie-workbuddy-tasks`，并在插件管理里启用。
2. 打开「WorkBuddy 任务」入口卡，进入看板；首次加载会读取账号与任务快照。
3. 排程默认是关的。想手动跑：勾选账号和任务腿（默认已勾「成长任务 / 连登管家 / 猫猫旅行」），点「批量做任务」；只想接取/领奖、或单独跑连登管家，用对应按钮。
4. 任务明细里可勾选任务，批量操作只做选中的；积分列会显示余额，点「明细」看套餐权益包。
5. **可选**：已有账号 JSON（hub / 旧机器 / 桌面端）？看板「导入 / 导出」→ 预览 → 确认，账号会合并进 magpie 的凭据库，magpie 和社区 WorkBuddy 插件都能直接使用。
6. 账号被 403 / 11140 风控冻结时，看板该行会出现红色「已冻结」徽章和「恢复」按钮；确认环境干净后再手动恢复——插件不会自动重试，避免同一设备的账号连坐。

## 账号导入 / 导出（可直接同步进 magpie）

看板账号卡片右上角有「导入 / 导出」，也可以直接调 API。**导入写的不是本插件的私有账本，而是 magpie 的凭据库 `plugin-auth.json`**：确认后这些账号会出现在 magpie 的 WorkBuddy 账号列表里，社区插件 `@magpie-community/opencode-workbuddy-auth`（对话）也能直接使用；反过来，在 magpie 里已经登录的账号，本插件无需导入即可复用。适合从 hub、旧机器或其他客户端迁移账号。

导入文件可能包含 access/refresh token，**不要发到公开渠道**；写盘前会自动备份。

**导出**（`GET /api/accounts/export`）：生成 hub 同款 `workbuddy-accounts` JSON。默认 `secrets=1`，**包含 access/refresh token**，下载文件请妥善保管；`secrets=0` 会删除两个 token 字段。默认只导国内版；显式 `realm=intl` 是 API 层的备份逃生口（看板不提供入口）。`uid=a,b` 可只导指定账号，`download=1` 触发附件下载。

**导入**（`POST /api/accounts/import`）：两段式。

1. **预览**（默认）：只读，返回 `adds / updates / skips / rejects` 和每个账号的原因，绝不写盘；
2. **确认**（`confirm:true`）：合并写入 magpie 的 `plugin-auth.json`，写前自动备份，只同步国内版，支持导出信封、裸数组、单账号对象、桌面端凭据和 cockpit snake_case 行。

智能合并规则（按顺序）：

- 导入项没有 `refresh` 而现有有 → **skip**（写进去会削弱续期能力）；
- 现有 token 尚未过期 → **skip**（绝不把在用的新 token 换成 JSON 里的旧 token）；
- 现有已过期且导入的 token 更新 → **update**，只改 `access / refresh / expires`，其它字段保留；
- 其余 → **skip**。

确认写入后，在 magpie 插件管理里把 WorkBuddy **关掉再打开**，宿主才会重新读取账号；之后本插件和 magpie 里的对话都使用这份登录态。

## 它做什么

一轮批量 job 按账号依次执行（同一时刻只允许一个 job，第二个请求得到 409 `busy`），可自由组合下面的能力：

| 能力 | 入口 | 实际行为 |
| --- | --- | --- |
| **批量做任务** | 看板「批量做任务」/ `POST /api/run` / 工具 `workbuddy_tasks_run` | 成长任务完整流水线：先做 `auto` 前置 → 批量接取（20 个一批，复查后补接一次）→ 逐个上报事件点亮并轮询进度 → 进度到位才领奖。没到位就把领奖顺延到下一轮，绝不硬闯 |
| **批量接任务** | 看板「批量接任务」/ `POST /api/task/accept` | 只接取引擎判定 `canAccept` 的任务，不点亮、不领奖。桌面端专属任务可以被接取，但不会伪造进度 |
| **只领奖** | 看板单账号「领取」/ `POST /api/task/claim` / 工具 `workbuddy_tasks_claim` | 领取单个已完成任务；批量运行时也会按 `claim:false` 只点亮不领奖 |
| **任务级勾选** | 看板任务明细 / `POST /api/run` 的 `codes` / 工具 `codes` | 按账号勾选任务，批量操作只作用于选中的 code；未勾选 = 全部任务。选中但任务表里不存在的 code 会警告一次并跳过 |
| **猫猫旅行** | 任务腿 `travel` | `arrived` 领奖 → `idle` 派出（先完成并领取 `first_buddy`）→ `traveling` 如实报告，一次推进一步 |
| **桌面任务链** | 成长腿自动 | `RichMeow_Chat` 走 6 条桌面会话事件链、`Buddy_App` 走 5 条 `buddyapp_*` 事件、`Library_read` 走 web 点击；`Buddy_App_QQ` 仍按桌面端专属跳过 |
| **Buddy 盲盒** | 任务腿 `buddy` | 用积累的**成长能量**开盲盒：`quota` 读出 `affordable`（还能开几个）与 `max_open_count`（单次上限），一次 `open` 批量开启 `min(affordable, max_open_count)` 个。**会消耗成长能量**；不领积分、不计入收益结算。能量不足时如实跳过（不发开盒请求）。腿顺序在 `travel` 之前：开出的 Buddy 可被随后的旅行使用 |
| **微信小程序链式任务** | 任务腿 `mp` / 成长腿内自动（`mpTasks:false` 可关）+ 快照/看板 | `Sequential_Tasks_1–6` + `school_season` 走**小程序埋点链路**（专属标头 + `WorkBuddy_MP` 事件指纹），接取/点亮/领奖一次完成；`codes` 勾选同样生效。**0.3.1 起进任务快照/看板**：快照刷新会在 web 清单之后用小程序头族再拉一份 MP 清单，只补充 web 清单里没有的 code（同一 code 以 web 为准）；单账号「接取 / 领取」对 MP code 自动改走小程序头族。**0.3.2 起可直接消费上游 `locked` / `unlock_at`**：次日才解锁的任务在看板显示「次日可接取」，勾选框禁用并提示解锁日期，批量/排程也不会把锁定任务塞进接取批次。注意 `workstation_expert`、`Sequential_Tasks_7` 等仍是 web 侧规格任务，等上游下发才出现。**`Sequential_Tasks_7` 即使同时出现在 MP 清单也归 web playbook 双事件链**（`isMPCode` 排除 `TASK_SPECS` 已收录的 code，MP 链路不会吃掉它）；**0.3.3 起 web 清单自带的锁字段同样生效**（实测 ST7 `locked:true`）：锁定任务整条跳过，不接取、不上报、不领奖 |
| **夜猫子** | 任务腿 `night` | `black_cat` 只在**北京时间 23:00–08:00** 上报，白天诚实跳过；每天计 1 次、累计 3 天。01:00 清单暂缺 `black_cat` 时会按 5/15/30s 重试约 50s；仍没有就如实跳过（不记失败） |
| **每日活跃** | 自动（每个 job 的每个账号开跑前） | 每个账号每个**北京日**往计费域上报一条 chat 事件，点亮成长中心连登。幂等账本 `state/daily-activity.json`，重启后同一天不重发；失败只记日志，不阻断任务 |
| **连登管家** | 任务腿 `streak` / 看板「连登管家」/ `POST /api/streak/run` | 一次把连登体系的日常收益收干净：用补签卡**补签昨日** → 领**新手礼包 / 活动补偿**（计费域）→ 兑换连登 **7d / 14d / 28d** 档位 → 按剩余次数**自动抽奖**。全部幂等：已补过 / 已领过 / 已兑换 / 无抽奖次数一律静默跳过，不硬闯不报错；企业版与 API key 账号**一个上游请求都不发**。看板账号行有「连登」条（连登天数 · 补签卡 · 抽奖次数 · 档位徽章 ＋ 近 28 天连登日历），`GET /api/streak` 只读查询（10 分钟缓存） |
| **每日签到** | 看板「每日签到」/ `POST /api/checkin` | 手动触发，不会自动跑（社区插件已负责 `auth.checkin`）。回执细分：`claimed` 新签到 / `done` 今天已签 / `pending` 处理中，可重试（`code=0` 但「请勿重复操作 / 系统繁忙」不再算成功）/ `failed` |
| **风控冻结与恢复** | 看板「恢复」/ `POST /api/account/unfreeze` / 工具 `workbuddy_tasks_unfreeze` | 命中 403 / 11140 立即冻结并写 `state/frozen.json`，从批量、排程选号、签到、连登管家的默认目标里排除；**只有手动恢复能解除**——不再自动冷却重试（同一设备的账号会连坐）。其他账号不受影响 |
| **积分余额与明细** | 看板积分列 / `GET /api/credits?uid=<uid>` | 只读查询国内版积分余额、每个套餐包的额度/已用/剩余/发放原因/到期时间，以及最早到期提示。看板有「明细」弹窗，可按状态筛选、搜索、排序、强制刷新 |
| **小时排程** | 看板排程区 / `POST /api/settings` | **默认停用，且五条腿（`mp` / `buddy` / `streak` / `travel` / `night`）默认都不排程——时间留空 = 不排**。启用后按**北京时间**运行：为某条腿显式配置小时窗口才会自动跑，同一北京日同一窗口只触发一次。**成长任务不在排程里**，只能手动或工具发起。**Buddy 盲盒会消耗成长能量**，不给明确授权绝不自动花；**小程序链式任务按天解锁**，可单独排程（默认不排） |
| **账号导入 / 导出** | 看板「导入 / 导出」/ `/api/accounts/export`、`/api/accounts/import` | 导出 hub 同款 `workbuddy-accounts` JSON；导入走「预览 → 确认写入」两段式，**合并写回 magpie 的 `plugin-auth.json`——不只是本插件，magpie / 社区 WorkBuddy 插件也能直接使用**，写前自动备份。只同步国内版 |
| **看板与入口卡** | 守护进程 `:4390` / magpie 插件页 | 账号、任务、积分、实时步骤/SSE、排程、历史；magpie 入口卡显示看板地址，按当前访问 magpie 的主机自动推导 |

风控红线（不可配置、不可绕过）：任意两次上游调用之间至少 **1s**；账号之间手动 **1.5s**、排程 **2–5s** 抖动；绝不并行跑成长任务；命中 403 / 11140（账号级风控）时该账号立即**冻结**，从批量/排程/签到/连登管家的缺省目标里排除，**只有手动「恢复」能解除**（不再自动冷却后重试——同一设备的账号会连坐）。

任务判定只有一个来源（`engine/taskkind.mjs`）：已知任务按 `TASK_SPECS`；小程序任务（`MP_TASK_SPECS` 命中，或 `Sequential_Tasks_` 前缀**且不在 `TASK_SPECS`**）走小程序链路——`Sequential_Tasks_7` 在 `TASK_SPECS`（web playbook/PC 灵感功能），绝不算 MP；未收录但 `jump_url` 能解出 `expertId=ex_…` 的 `expert_use_*` 任务会钉住该专家 id 点亮；其余未收录、桌面端专属、`unforgeable` 任务一律不伪造进度。

### 看板里有什么

- **账号表**：账号（昵称 / 域名 / uid）、凭据（登录状态、剩余天数）、任务进度、积分余额、参与开关、刷新快照。
- **任务明细**：展开每个账号的任务表；首列是勾选框，表头和提示条支持全选/半选。**勾选后批量操作只作用于选中任务，不勾选 = 全部。**
- **连登条**：账号行下方显示连登天数 / 补签卡 / 抽奖次数、7d·14d·28d 档位徽章与「连登管家」按钮；「连登日历」可展开成 28 天格子日历（上游一次给一整年，看板只画最近 28 天，否则会是 53 行细长条）（未查询时显示「未查询」+「查询」）。
- **积分**：任务进度右侧显示 `剩余 / 总额` 与「明细」按钮；最近 7 天内有套餐到期会显示提醒。
- **积分明细弹窗**：剩余可用 / 已消耗 / 总额度 / 最近将过期四张卡；额度利用率；套餐包表格（来源、到期倒计时、总额度、已用、剩余、利用率）；筛选「全部 / 有剩余 / 即将到期 / 已用完或过期」；搜索包名/代码/来源；四种排序；「刷新明细」。
- **批量条**：任务腿（成长 / 小程序 / 连登管家 / 盲盒 / 旅行 / 夜猫）、自动领奖、批量接任务、只领奖、连登管家、每日签到、批量做任务。
- **排程**：启用开关、连登管家/旅行/夜猫子/盲盒/小程序的小时窗口（北京时间，默认全空 = 不排）、下一次运行。
- **冻结与恢复**：403/11140 冻结的账号标红徽章 + 「恢复」按钮，批量区显示「N 个账号已冻结」并可全部恢复；签到回执区分「新签到 / 今天已签 / 处理中，可重试 / 失败」。
- **历史**：每次尝试一行；「触发」列区分「排程 / 手动」。
- **实时进度**：SSE 推送步骤与日志；断线自动回退 3 秒轮询。

## 它刻意不做什么

- **自动签到**：社区插件 `@magpie-community/opencode-workbuddy-auth` 已有 `auth.checkin`（每个北京日一次）。本插件不声明 provider，也不实现 `auth.checkin`；看板只保留一个走计费接口的「每日签到」按钮（`POST /api/checkin`）供偶尔手动补用。
- **桌面端专属伪装**：只剩 `Buddy_App_QQ` 仍按真实桌面行为处理（看板只给深链，任务停在未完成）。`RichMeow_Chat`（RichMeow）已用 **6 条桌面会话事件链**点亮；`Buddy_App` 已用 **5 条 `buddyapp_*` 事件 + 桌面指纹**实测通过（2026-11-06：进度 0→1、领奖 +100）；`Library_read` 走 web 点击事件。三者都已从 `DESKTOP_ONLY_TASKS` 移出。
- **无法自动化的任务**：`wb_wechat_oa_subscribe_task`（需关注公众号满 24 小时）、`Expert_Philanthropy`（真实捐款）不接取、不上报、不领奖。
- **不做遥测、不上传数据**：除了你让它打的 WorkBuddy 上游请求，插件不向任何第三方发送数据；看板、API、状态文件都只在本机（或你自觉暴露的局域网）里，token 只从 magpie 的 `plugin-auth.json` 读取，绝不写进页面。
- **国际版**：`workbuddy-ai` 不进账号列表、不进快照/统计、不参与任务、默认不导出；`/api/state` 只给一个 `intlSkipped:{count,note}` 计数说明去向。
- **不服务对话模型、不声明 provider**：没有 `auth`/`config` 钩子，magpie 的「供应商」列表里不会出现本插件，也就没有「未登录」卡和登录按钮。`workbuddy` / `workbuddy-ai` 两个 provider id 始终归社区插件，对话链路不动。

## 账号复用与 token 回写

- **读取**：守护进程读 magpie 配置目录下的 `plugin-auth.json`，只认 `workbuddy` / `workbuddy#xxxxxxxx` 键。API key 条目、企业/团队账号（`enterpriseId`）、国际版都不参与任务；国际版在插件使用侧就被过滤掉。
- **回写**：批量任务开始前，如果 access token 距到期不足 **5 分钟**，引擎先刷新，再**原子回写** `plugin-auth.json`（tmp + rename，POSIX mode 600）。只覆盖 `access / refresh / expires / refreshExpiresAt / domain / tokenType` 六个键；未知字段和其它 provider 的兄弟条目原样保留；文件解析失败时拒绝写入。
- 这样社区插件和本插件始终用同一对 token，refresh 轮换不会把对方踢下线——官方插件负责的对话不受影响。
- **这是最脆弱的一环**：`plugin-auth.json` 的位置和格式不是 magpie 承诺的公开接口。magpie 改格式时，最坏情况是登录态需要重新扫码；解析失败我们会拒绝写入，不会损坏 magpie 的数据。
- **Opt-out**：在 magpie「插件管理」里停用本插件，守护进程 10 秒内读到 `plugins.json` 的 `off:true` 后自行退出，之后不再读任何文件。也可以按账号关「参与任务」，但账号仍会被读取用于展示。

## 安装

前提：

1. 已安装 magpie；
2. 已安装社区插件 `@magpie-community/opencode-workbuddy-auth`，并在 magpie 里登录过 **WorkBuddy 国内版**（`workbuddy`）账号。

GitHub 安装：

```bash
magpie plugin add github:jichie/magpie-workbuddy-tasks
```

首次 `add` 如果提示 `the plugin's load didn't finish in 20s`：这是 Bun 第一次现场拉取 `@opencode-ai/plugin` 的冷启动开销（群晖容器实测冷启动可到 45s，热启动约 23ms）。拉取会在后台完成并进缓存，**再 add 一次，或在插件管理里停用→启用一次**即可。

本地文件夹安装（开发/自建）：

```bash
magpie plugin add /path/to/magpie-workbuddy-tasks
```

安装后在 magpie 的「插件管理」里**启用**本插件。启用后：

- 侧栏「插件」分组出现「**WorkBuddy 任务**」入口卡；看板地址按你访问 magpie 的主机自动推导（同一主机 + 4390 端口），可用插件选项 `dashboardUrl` 覆盖。
- **「供应商」里不会多出任何条目**。如果从旧版本升级后仍看到「WorkBuddy 任务: 未登录」，那是 magpie 缓存的旧 provider：重启 magpie，或先备份、再从 `plugin-providers.json` / `cache/magpie/providers-state.json` 中删掉 `workbuddy-tasks` 条目即可。
- 沙箱页不允许弹新窗口：点「打开看板」会先尝试新窗口，被拦时自动复制地址并提示；也可以右键链接「在新标签页中打开」。

**更新**：把改动推到默认分支，magpie 每 10 分钟最多检查一次 GitHub，有更新会在「插件 → 已安装」提示；点更新或执行 `magpie plugin update`。固定到某次提交的安装（`#<sha>`）不会自动更新。

**重载语义**：magpie 按仓库当前代码直接加载，没有构建步骤。应用内宿主不会热重载；本地改动或 `plugin update` 后，在「插件管理」里把插件**关掉再打开**，或用你的 magpie 版本提供的重载命令。

**插件选项**：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `dashboardUrl` | 空 | 留空 = 按当前访问 magpie 的主机自动推导 `http(s)://<host>:4390`；显式填写可覆盖 |
| `listenAddress` | 空 | 守护进程绑定地址；Docker/局域网需要设为 `0.0.0.0` |

## 智能体工具（MCP）

本插件向 magpie 的 MCP 工具服务注册 7 个工具，任何接入 `http://127.0.0.1:3425/mcp/magpie/tools` 的智能体都能用：

| 工具 | 作用 |
| --- | --- |
| `workbuddy_tasks_status` | 账号、排程窗口、当前 job、今日收益一览 |
| `workbuddy_tasks_run` | 启动一轮批量任务，立即返回 job id；参数 `uids?`、`legs?`、`claim?`、`codes?` |
| `workbuddy_tasks_wait` | 轮询 job 直到完成或超时（默认 45s，上限 50s） |
| `workbuddy_tasks_list` | 某账号的任务表（code / 标题 / 接取状态 / 进度 / 奖励） |
| `workbuddy_tasks_claim` | 按 uid + code 领取单个任务 |
| `workbuddy_tasks_streak` | 跑连登管家（补签 / 礼包补偿 / 档位兑换 / 抽奖），参数 `uids?` |
| `workbuddy_tasks_unfreeze` | 解冻被 403/11140 冻结的账号，参数 `uid?` / `uids?` |

每个工具单次最多执行 55 秒，装不下一轮跨账号批量，所以它们只负责**启动或轮询**，实际执行在守护进程里。批量任务运行中，单账号操作会得到 409 `busy`，避免抢限速窗口。

## HTTP API

全部接口**不需要密钥**（用户明确要求的局域网自建工具口径），完整字段以 [`docs/CONTRACT.md`](./docs/CONTRACT.md) 为准：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/hello` | 名称、版本、引擎是否就绪 |
| `GET /api/state` | 账号、任务快照、积分缓存、排程、当前 job、今日统计、设置、`serveUrl`/`bindHost`/`port`/`intlSkipped` |
| `POST /api/run` | `{uids?, legs?, claim?, codes?}` 启动 job；`codes` 支持 `string[]` 或 `{[uid]: string[]}` |
| `POST /api/stop` | 取消当前 job |
| `POST /api/task/claim` | `{uid, code}` 单任务领奖 |
| `POST /api/task/accept` | `{uid, codes[]}` 单账号接取 |
| `POST /api/checkin` | `{uids?}` 手动每日签到（不自动）；回执 `claimed`/`done`/`pending`/`failed` |
| `GET /api/streak` | `?uid=<uid>&refresh=0 或 1` 连登状态（天数 / 补签卡 / 抽奖次数 / 档位 / 整年日历数据）；缓存 10 分钟 |
| `POST /api/streak/run` | `{uids?}` 跑连登管家：补签 → 礼包补偿 → 档位兑换 → 抽奖 |
| `POST /api/settings` | 部分设置：排程开关、北京时间窗口、默认腿、领奖、间隔、host |
| `POST /api/accounts` | 重新读 `plugin-auth.json`，报告账号增删 |
| `GET /api/accounts/export` | `?realm=cn 或 intl`、`secrets=0 或 1`、`uid=a,b`、`download=1`；默认国内版、默认含 token |
| `POST /api/accounts/import` | 预览/确认两段式导入；确认后写 `plugin-auth.json` 并备份 |
| `POST /api/account/toggle` | `{uid, tasksEnabled}` 参与任务开关 |
| `POST /api/account/unfreeze` | `{uid}` 或 `{uids}` 解除 403/11140 冻结 |
| `GET /api/credits` | `?uid=<uid>&refresh=0 或 1` 积分余额与套餐明细；缓存 10 分钟 |
| `GET /api/jobs/:id` | 查询某个 job |
| `GET /api/history` | `?limit=200` 每次尝试一行；`trigger` 为 `schedule` 或 `manual` |
| `GET /api/events` | SSE：`job` / `step` / `log` / `scheduler` / `accounts` / `credits` |
| `POST /api/shutdown` | 让守护进程退出 |
| `GET /` | 看板静态页（同源，无构建） |

`codes` 的两种形状：

- `["task_a", "task_b"]`：对 job 内所有账号生效；
- `{"uid-a": ["task_a"], "uid-b": ["task_b"]}`：按账号生效，未出现的账号 = 全部任务。

## 排程与时间口径

- **全部按北京时间（UTC+8）** 解释小时窗口、夜猫子窗口、每日活跃日界和积分到期时间；magpie 容器通常跑在 UTC，引擎不读宿主 `getHours()`。
- 排程**默认停用**。第一次装好不会自动往账号打上游请求，必须你在看板里点一次「启用小时窗口排程」。
- 五条可排程腿（`mp` 小程序 / `buddy` 盲盒 / `streak` 连登管家 / `travel` 旅行 / `night` 夜猫子）默认**全空 = 都不排**；只有你在看板或 `POST /api/settings` 里给某条腿填了小时（0–23 整数，北京时间）才会到点执行。
- **手动批量**的默认腿是 `growth + streak + travel`（`settings.legs`，可在看板批量条取消勾选）；`buddy` 会消耗成长能量，默认不勾。
- **成长任务不在排程里**：自动到点跑的都是无任务码的腿；成长任务只能手动（看板 / `POST /api/run` / 工具），可配合 `codes` 只做选中任务。
- **Buddy 盲盒需要显式授权**：开盲盒会消耗成长能量，默认不勾、也不排程；只有你显式勾选或给 `hours.buddy` 配了窗口才会跑。
- 守护进程每 30 秒检查一次窗口；同一北京日同一窗口只触发一次（`state/lastFired.json`，日期段是北京日期）。有 job 在跑时让路。
- 夜猫子 `black_cat` 只在 23:00–08:00 计数，每天 1 次、累计 3 天。
- 每日活跃在每个 job 的每个账号开跑前执行一次；同一北京日不重发。

## 数据与隐私

- **不采集、不上报**：没有遥测、没有分析、没有第三方请求。唯一的出站流量是你要它发的 WorkBuddy 上游请求，以及 magpie 自己负责的 GitHub 更新检查。
- **token 只在本机流转**：登录态从 magpie 的 `plugin-auth.json` 读取，只在内存里用于签名；需要续期时原子回写同一份文件（tmp + rename，mode 600），未知字段原样保留，**从不删除**凭据文件。
- **状态都在本地**：账号开关、任务快照、历史、积分 / 连登缓存、冻结台账全部在 `<magpie 配置目录>/workbuddy-tasks/state/`；删掉该目录即可清空本插件痕迹（登录凭据不在这里）。
- **导出要当心**：`GET /api/accounts/export` 默认包含 access / refresh token，下载文件自行保管；对外分享前加 `secrets=0`。
- **公开仓库做过脱敏**：文档与代码里的内网地址、真实账号昵称一律用占位（`192.0.2.*`、实测账号），看板截图等本地产物不入库（`.gitignore`）。

## 看板与局域网安全

- 看板默认 `http://127.0.0.1:4390/`。端口被占用时自动顺延（最多 +9，再不行随机端口），实际端口和绑定 host 写在 `state/daemon.json`。
- 所有 API 与看板**免密钥**：读状态、跑任务、改设置、单账号领奖/接取/签到、开关账号、导入确认写盘、含 token 的账号导出、关停守护进程，一律不需要鉴权。
- 安全性**完全由网络边界负责**：
  - 默认只绑 `127.0.0.1`，只有本机进程能访问；
  - Docker 里只有把 `options.listenAddress` 设为 `"0.0.0.0"` 才会暴露到容器网桥/局域网；
  - **不要把 4390 发布到公网或开放的 LAN**。能连上端口的人可以触发任务、写入 `plugin-auth.json`、下载含 token 的导出、关停守护进程。
- 跨机器访问推荐 SSH 隧道（隧道本身就是鉴权）：

  ```bash
  ssh -L 4390:127.0.0.1:4390 <user>@<跑 magpie 的机器>
  ```

- `state/daemon.json` 里的 `key` 字段**仅为向后兼容保留**，不是访问凭据，任何接口都不校验；旧调用带 `Authorization: Bearer …` 或 `?k=…` 仍可用。

## 生命周期

- 守护进程由插件入口 `index.mjs` 在 **magpie 插件宿主加载本插件时**拉起：健康探测通过就复用，不健康才 spawn 一个 detached 的 `node daemon.mjs`。
- magpie 宿主是懒加载的：首次用到本插件（打开插件页 / 用到工具）才加载；插件新增/移除/更新/开关都会重启宿主。启用后看板不一定立刻在，可用看板顶栏「启动命令」或手动启动：
  
  ```bash
  node daemon.mjs --cfg <magpie 配置目录> --state <state 目录> --port 4390
  ```

- 守护进程自己跟随 magpie：
  - 每 15s TCP 探测 magpie 网关，连续 4 次失败（magpie 停了）→ 退出；
  - 每 10s 读 `plugins.json`，本插件 `off:true` → 10 秒内退出；
  - 每 5s 检查 `state/control.json`，`desired:"off"` → 退出；
  - 托管模式下插件条目被移除（卸载）→ 退出。
- 重复启动会被 `daemon.json` 里的存活 pid + `/api/hello` 健康探测挡下，不会双开。

## 状态文件

全部在 `<magpie 配置目录>/workbuddy-tasks/state/`（Docker 通常是 `/config/magpie/workbuddy-tasks/state/`）：

| 文件 | 内容 |
| --- | --- |
| `control.json` | 唯一意图来源：`{"desired":"on"/"off"}` |
| `settings.json` | 排程开关、北京时间窗口、默认腿、领奖、账号间隔、上游 host |
| `snapshots.json` | 每账号任务快照（job 结束或 `?refresh=` 时刷新） |
| `history.json` | 每次尝试一行（上限 2000）；`trigger` 为 `schedule`/`manual` |
| `accounts.json` | 按账号的参与任务开关覆盖 |
| `tasks-accounts.json` | 引擎层按账号键的参与开关映射 |
| `daemon.json` | pid / port / host / version / startedAt（`key` 仅兼容保留） |
| `daemon.heartbeat` | 心跳时间戳 |
| `lastFired.json` | 排程去重：北京日期 + 窗口 |
| `daily-activity.json` | 每日活跃幂等账本：`{uid:"YYYY-MM-DD"}` |
| `credits.json` | 积分余额缓存：`{uid: credits}`，10 分钟 TTL |
| `streak.json` | 连登状态缓存：`{uid: streak}`，10 分钟 TTL（`/api/state` 只读投影它） |
| `frozen.json` | 403/11140 冻结台账：`{uid:{at,code,message}}`，只有 `POST /api/account/unfreeze` 能删 |
| `hub-imports.json` | 经 JSON 导入的账号台账（`imported` 展示标记） |

登录凭据 `plugin-auth.json` 在 magpie 配置目录**根部**，由 magpie/社区插件拥有：我们只读 + 原子回写，**从不删除**。想彻底清掉本插件痕迹，删 `<magpie 配置目录>/workbuddy-tasks/` 整个目录即可（里面没有登录凭据）。

## 故障排查

| 症状 | 原因与处理 |
| --- | --- |
| 「没有可参与任务的账号」 | 需要 magpie 里已登录的国内版 `workbuddy` **OAuth 个人账号**；API key、企业/团队、国际版都不参与。也可能是账号被「参与任务」开关停用。Docker 自定义安装时多半是配置目录不对：给守护进程设 `MAGPIE_CONFIG_DIR=/config/magpie` 后重启。看板「重新扫描」或 `POST /api/accounts` 可立即重扫 |
| 「任务引擎不可用」/ `/api/run` 503 | `engine/*.mjs` 缺失或加载失败；补齐 `engine/` 后在插件管理里关/开一次 |
| 触发风控限制（403 / 11140） | 账号级风控。引擎立即停手并**冻结该账号**（写 `state/frozen.json`），从批量 / 排程选号 / 签到 / 连登管家的默认目标里排除；确认环境干净后，在看板点该账号的「恢复」或 `POST /api/account/unfreeze` 才继续——**不会自动重试**（同设备账号会连坐） |
| 签到显示「处理中，可重试」 | 上游回 `code=0` 但文案是「请勿重复操作 / 系统繁忙 / 稍后再试」——插件不把它记成已领，当天可以再点一次 |
| web 任务显示「次日可接取」 | 上游给任务带了 `locked:true` + `unlock_at`（如 `Sequential_Tasks_7`）。到解锁日再跑；插件不会提前接取 / 上报 / 领奖 |
| 桌面端专属任务一直未完成 | 目前只剩 `Buddy_App_QQ` 仍按真实桌面行为处理，看板只给深链。`Buddy_App`（5 连）、`RichMeow_Chat`（RichMeow 6 连）和 `Library_read`（web 点击）已可自动点亮 |
| 排程到点没跑 / 跑错腿 | 先确认排程开关已启用；小时是**北京时间**；同一北京日同一窗口已触发过会跳过（`lastFired.json`）；有 job 在跑时让路。成长任务本来就不在排程里 |
| 夜猫子显示「未下发，跳过」 | 上游当晚没有下发 `black_cat`（活动已结束、今日已领或日切未完成）。01:00 会先重试 4 次约 50s；仍没有就按跳过处理，不是插件故障 |
| 小程序任务接取失败：`task locked until …` | 小程序链式任务按天解锁：完成前一个任务后，下一个任务次日才可接。日志会显示锁定日期，到日期再跑即可 |
| 历史「触发」显示手动 | 旧版本写入的旧行不会自动回溯；修复后新产生的排程行显示「排程」。手动跑的行始终是「手动」 |
| 积分显示「未查询」/ 刷新返回 409 | 守护进程会在空闲时拉取；批量任务运行中需要拉取会返回 409，等 job 结束再点「查询/刷新明细」。登录过期会带 `needRelogin:true`，重新登录 WorkBuddy 即可 |
| 看板连不上 | 宿主懒加载 + 插件开关会重启宿主。用看板顶栏「启动命令」或手动 `node daemon.mjs --cfg <配置目录> --port 4390` |
| 如何彻底停止 / 启动 | 停：插件管理里关掉（10 秒内退），或写 `state/control.json` `{"desired":"off"}`，或看板「停止守护进程」。启：插件管理里打开，或手动命令 |
| magpie 跑在 Docker 里 | 配置目录通常是 `/config/magpie`；手动启动时在容器内执行，或确保挂载路径一致 |
| Windows 路径 | 默认配置目录是 `%USERPROFILE%\.config\magpie`（不是 AppData）；路径含空格/反斜杠要加引号。chmod 600 在 Windows 上近似空操作 |

## 目录与测试

```text
index.mjs        插件入口（7 个 MCP 工具、守护进程生命周期；不声明 provider）
lifecycle.mjs    守护进程 spawn / 健康探测 / control.json / daemon.json
daemon.mjs       常驻进程：HTTP 看板 + /api + SSE + 北京时间排程 + 任务调度
engine/          任务引擎
  store / accountio        读 plugin-auth.json、导入导出
  upstream / identity      信封、重试、头族、全局节流
  tasks / taskkind         成长任务流水线、任务 → kind 判定
  miniprogram              微信小程序链式任务（Sequential_Tasks 系列 + 校园日）
  travel / buddy / daily   猫猫旅行、Buddy 盲盒、夜猫子、每日活跃
  streak                   连登管家（补签 / 档位兑换 / 抽奖 / 礼包）
  runner / schedule        跨账号编排、北京时间窗口
  credits                  积分余额与套餐明细（只读）
  constants / fingerprint  上游常量、设备指纹
dashboard/       看板前端（纯静态，无构建；API 免密钥）
page/            magpie 沙箱入口卡
tests/           引擎单元测试（fetch 全 mock）
tests-shell/     守护进程外壳测试
tests-e2e/       全链路集成测试（假上游 + 假时钟）
docs/CONTRACT.md 内部契约（实现必须遵守的接口与红线）
```

```bash
node --test "tests/**/*.test.mjs" "tests-shell/*.test.mjs" "tests-e2e/*.test.mjs"
```

当前 **403 个测试全绿**，全部零真实网络：上游由脚本化假 WorkBuddy 提供，时钟可注入；覆盖限速红线、403/11140 冻结与解冻、签到回执细分、连登管家幂等与跳过、任务勾选、北京时间排程、Buddy 盲盒、小程序链式任务、积分解析、导入导出、凭据回写等。

## 更新日志

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。最近的版本：

- **0.3.4**（2026-11-11）：企业版账号默认过滤（与国际版同口径，只留忽略计数；并修掉显式指定企业版时签到/接取/领奖/刷新快照会真打上游的四处侧门）；「未知 API」类错误改为明确提示「守护进程版本落后、需重启」，看板顶栏「实时 · SSE」右边新增版本不一致告警胶囊。
- **0.3.3**（2026-11-11）：新增**连登管家**任务腿（补签昨日 / 新手礼包与活动补偿 / 7d·14d·28d 档位兑换 / 自动抽奖）与看板「连登」条 + 28 天连登日历；新增 4 个专家活动任务规格；签到回执细分出 `pending`（修复「请勿重复操作」被记成已领的假成功）；**403/11140 改为冻结账号**，只有手动恢复能解除（不再 2 小时自动冷却）。 web 清单自带的 `locked/unlock_at` 同样生效（实测 `Sequential_Tasks_7`），`Sequential_Tasks_7` 归 web playbook 执行通道。
- **0.3.2**（2026-11-07）：小程序链式任务读取上游 `locked/unlock_at`，看板锁定不可勾选并提示次日可接；新增独立 `mp` 排程腿；排程时间留空 = 不排（默认全空）；只勾成长任务不再顺带跑猫猫旅行。
- **0.3.1**（2026-11-06）：`Buddy_App` 5 连自动化；小程序任务进快照/看板、可勾选/接取/领奖；接取失败原因与「没有新收益」文案修正。
- **0.3.0**（2026-11-06）：Buddy 盲盒独立腿；小程序链式任务执行；RichMeow 6 连；playbook 双事件与新任务规格。
- **0.2.0**（2026-11-01）：积分余额/套餐明细；每日活跃连登；任务级勾选；北京时间排程。

## 来源与致谢

- 任务流水线、账号 JSON 导入/导出、积分数据口径参考 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)。
- 「资料库」web 点击点亮与每日活跃参考社区项目 [magpie-workbuddy-growth](https://github.com/connoryang331/magpie-workbuddy-growth)。
- 小程序链式任务的埋点协议与任务链设计参考 [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily)（MIT）；猫猫旅行与 Buddy 盲盒安全生命周期参考 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT）。
- magpie 插件 API 与沙箱页规范来自 [usemagpie.ai](https://usemagpie.ai/docs/zh/plugins)；账号登录态由 `@magpie-community/opencode-workbuddy-auth` 提供。

本项目与 WorkBuddy / 腾讯、magpie 官方均无隶属关系。

## 许可

MIT，见 [LICENSE](./LICENSE)。
