# wbkit

**补在社区插件后面的那一半。**
供应商、登录、请求签名与余额交给 [`@magpie-community/opencode-workbuddy-auth`](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)；wbkit 补上它没有的：账号池、每日签到补位、猫猫旅行、批量成长任务、模型目录、官方用量，以及一个能一眼看完所有账号的页面。

> 版本 `0.5.10` · magpie 插件 · 零 npm 依赖 · MIT

```
@magpie-community/opencode-workbuddy-auth   →  WorkBuddy 供应商 / 登录 / 余额
wbkit                                       →  账号页、签到、旅行、成长任务、模型、用量、四个工具
```

## 长什么样

紧凑视图（一行一账号，点击展开详情；截图里的账号名是示例）：

![紧凑视图](docs/preview-compact.png)

卡片视图（大号余额 + 每个积分包的进度条；一行三张）：

![卡片视图](docs/preview-card.png)

<details>
<summary>深色主题</summary>

![深色紧凑视图](docs/preview-dark.png)

</details>

## 它不做什么

wbkit **不注册 `provider`、不接管登录**，所以不会和社区插件抢供应商 id，也不会顶掉它的 `auth.usage`。唯一会碰的是签到：执行前先看 magpie 原生签到记录，已经签过就不发请求。

## 功能

### 账号池
导入 / 导出 / 列表 / 探活 / adopt（把孤儿账号键搬回已装插件声明的 provider id）。导入支持数组、`{accounts:[…]}`、单对象三种形状，按 `uid` 去重，账号名优先用昵称。**账号数没有上限**——增量导入只加不删，可分次加到几十个；导入并发跑（上限 5 个并行），账号多也不会顶到插件加载的 20 秒上限。新增账号后插件会自动重启一次，让 magpie 立刻认到新账号进路由。

### 每日签到
开关 + 时间（默认 09:05，北京时间）+「立即签到」。到点后按 ±3 分钟随机散开，避免多账号同时打接口。执行前先看 magpie 原生签到与插件钩子记录，没签过才补，不会重复领。

### 猫猫旅行
开关 + 间隔（默认 30 分钟，实际按 ±20% 随机抖动）。一次一步：没猫就领养，`idle` 派出，`arrived` 领奖，`traveling` 跳过；也能「推进一步」立刻走。

### 成长任务
- 手动：账号行里直接点「成长」，走引擎完整流水线——接取 → 点亮 → 轮询进度 → 达标才领奖。
- 每日自动：开关 + 时间（默认 09:10）。到点后随机推迟 0–5 分钟起跑，账号之间随机间隔 4–10 秒，避免风暴；引擎内部还有步骤间隔与 `403 / 11140` 冷却兜底。

### 模型目录与官方用量
`wbkit_models` 只读直连模型目录与套餐（不调模型、不花积分）；`wbkit_usage` 按天 / 模型汇总请求与积分消耗，明细不含任何提示词内容。

## 安装

先有登录，再补这一半：

```bash
magpie plugin add @magpie-community/opencode-workbuddy-auth    # 供应商 + 登录
magpie plugin login workbuddy                                  # 浏览器 / 桌面登录态 / API Key

magpie plugin add github:zseeu1/wbkit                          # 本插件
magpie quota                                                   # 余额卡来自社区插件
```

开发时就地加载，改完关掉再打开插件即可：

```bash
magpie plugin add ./wbkit
```

装好后「设置 → 插件」里会有两行：社区插件那行带 `workbuddy (… models)`，wbkit 那行带 `page` 与 `tools`。

## 登录

三种方式，都不用手动复制令牌：

- **浏览器登录**：`magpie plugin login workbuddy`，扫码或账号密码；
- **桌面登录态**：复用 WorkBuddy 桌面 App 已登录的账号（5.6 起该文件加密，此时改用浏览器登录）；
- **API Key**：在 WorkBuddy 的 keys 页面生成，登录时选 API Key 填入。

一个 provider 可登多个账号：第一个存在 `workbuddy`，之后的是 `workbuddy#<后缀>`。想批量导入用 `wbkit_pool`。

| 登录方式 | 出现在页面 | 余额 / 积分包 | 签到 | 旅行 / 成长 |
|---|---|---|---|---|
| 浏览器 | ✅ | ✅ 现取官方接口 | ✅ | ✅ |
| 桌面登录态 | ✅ | ❌ 令牌在客户端里，余额看供应商页 | ❌ | ❌ |
| API Key | ✅（标签 `API key ·尾四位`） | ❌ 不显示积分 | ❌ | ❌ |

读不到余额的两类只写一句原因，不会硬打接口，也不会假装成「读取失败」。

## 页面

侧栏「WorkBuddy」：

- 顶部汇总：可用积分 / 账号数 / 最近作废时间；分档：全部 · 国内版 · 国际版。
- **两种密度**：卡片（大号余额 + 积分包）与紧凑（一行一账号，可点开详情）。
- 折叠行：余额 + 剩余/总量进度条，进度条末段按积分包到期时间上色（≤2 天橙、≤10 天绿橙），状态点依次是 健康 / 签到 / 成长 / 旅行。
- 展开行：左栏登录态与积分包明细，右栏签到 / 成长 / 猫猫旅行三块，动作按钮贴在各自标题右侧。
- 底部：每日签到、猫猫旅行、成长任务的开关与时间；导入 / 导出账号；任务进度表。
- 页面顶部「刷新」= 改一次 options → 宿主重载插件 → 重生成快照 → 整页重载。

页面跑在沙盒 iframe 里（`connect-src 'none'`），既不联网也读不到账号，数据来自插件加载时写的一份只读快照 `page/data.js`——只含昵称、区域、余额、到期这类字段，**不含任何令牌**。

## 选项

页面上的开关都写进插件 options，也可以命令行改：

```bash
magpie plugin options wbkit '{"autoCheckin":true,"autoTravel":true,"autoTasks":true}'
```

| 键 | 默认 | 含义 |
|---|---|---|
| `autoCheckin` | `false` | 每日签到开关 |
| `checkinAt` | `09:05` | 北京时间，到点后才签（±3 分钟抖动） |
| `autoTravel` | `false` | 猫猫旅行自动推进开关 |
| `travelEveryMin` | `30` | 旅行推进间隔（最小 5，±20% 抖动） |
| `autoTasks` | `false` | 每日自动成长任务开关 |
| `taskAt` | `09:10` | 北京时间，到点后随机推迟 0–5 分钟起跑 |
| `density` | `card` | 页面密度：`card` / `compact` |
| `tab` | `all` | 分档：`all` / `cn` / `intl` |
| `pendingCheckin` / `pendingTravel` / `pendingAction` | — | 页面按钮写入的即时请求，插件消费一次 |

## 工具

装好后任何 agent 都能调（magpie 通过 `/mcp/magpie/tools` 暴露，前缀 `wbkit_`）：

```
wbkit_pool    --action import|export|adopt|list|check  [--path <导出 JSON>] [--uid <前缀>] [--probe true|false]
wbkit_growth  --action status|task|school|travel|streak|daily  [--code …] [--only …] [--lottery true]
wbkit_models  （无参数，返回国内 / 国际模型与套餐；只读）
wbkit_usage   --period 1d|7d|30d  [--uid <前缀>] [--detail 0-1000]
```

终端里同样能调：

```bash
magpie tool wbkit_pool --action import --path ~/Downloads/wb-switch-accounts.json
magpie tool wbkit_usage --period 7d --detail 20
magpie tool wbkit_growth --action status
```

- `wbkit_pool import` 不指 `path` 时先扫 `~/.config/magpie/workbuddy-pool/*.json`，再退回 `~/.wb-switch/accounts.json`。
- 导入默认是**增量**的：只加/更新，不删别的账号——分次加账号不会互相顶掉，账号池可以加到几十个。要「拿一整份导出覆盖账号池」（清理清单外的旧账号）时，给 import 加 `--prune true`。
- `wbkit_pool export` 写 wb-switch 格式（**含令牌**，等同密码，别上传网盘）。
- `wbkit_growth` 只对国内个人账号（无 `enterpriseId`）生效。

## 数据来源

全部现取官方接口，不读第三方缓存：

| 数据 | 端点 |
|---|---|
| 余额 / 额度窗口 | 社区插件的 `auth.usage` |
| 逐包明细 | `POST https://copilot.tencent.com/v2/billing/meter/get-user-resource` |
| 请求用量 | `POST https://www.workbuddy.cn/billing/meter/get-user-request-usage`（国际版 `www.workbuddy.ai`） |
| 每日签到 | `POST https://copilot.tencent.com/v2/billing/meter/daily-checkin` |
| 成长 / 旅行 | `copilot.tencent.com` 的 activity 接口 |

请求头照抄 WorkBuddy 桌面客户端；余额按 `CycleEndTime` 过滤、按 `PackageName` 合并，`DeductionEndTime` 超过两年视为长期有效。

## 目录

```
index.mjs            插件入口：工具 + chat.headers 时机，其余挂 _internal
lib/actions.mjs      单账号动作 + 每日自动成长（防风控抖动 / 账号间隔）
lib/schedule.mjs     签到调度（一天一次、±3 分钟抖动、手动请求消费）
lib/pet.mjs          猫猫旅行：状态查询与推进（±20% 间隔）
lib/transfer.mjs     导入 / 导出（wb-switch 格式）
lib/checkin.mjs      每日签到
lib/quota.mjs        余额 / 积分包 / 到期
lib/usage.mjs        官方用量：分页扫描 + 按天 / 模型聚合
lib/growth.mjs       成长计划原语（任务树、开学季、连登、旅行）
lib/engine/          批量任务引擎：接取 → 点亮 → 轮询 → 领奖，风控冷却
lib/{pools,importer,store,region,wb,snapshot}.mjs   账号池
lib/keys.mjs         账号键规则（裸键=默认账号、#后缀=其余）
lib/adopt.mjs        孤儿账号键搬家（加载时自动跑，幂等）
lib/view.mjs         页面快照（白名单字段，无令牌）
lib/tools.mjs        四个工具的实现
page/                index.html / app.js / style.css / panels.js / servicebar.js / icon.svg（data.js 生成，不入库）
tools/               命令行：导入、巡检、重生成快照
test/                node --test，62 条
docs/                README 截图
```

## 开发

```bash
npm test                     # 62 条：登录方式、账号键规则、孤儿键搬家、导入幂等、余额口径、签到判定、用量聚合、快照不含令牌等
node tools/snapshot.mjs      # 手动重生成 page/data.js
```

## 边界

- **不做**切客户端登录态（WorkBuddy 桌面、CodeBuddy IDE/CLI、VS Code、JetBrains）：magpie 是网关，账号在 provider 层轮换。
- **不做**会话复制 / 关联同步：`~/.workbuddy` 下的 SQLite 与 JSONL 写入，风险与收益不成比例。
- **不做**自动轮换：magpie 的 Routing 已经在做。

## 许可

MIT。`lib/growth.mjs`、`lib/{pools,importer,store,region,snapshot,wb}.mjs` 来自 MIT 许可的社区项目，出处见 [NOTICE](NOTICE)。供应商与登录不在本包内，由社区插件提供。
