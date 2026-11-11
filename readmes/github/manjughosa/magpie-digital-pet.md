# magpie-digital-pet

> **非官方插件**：本插件由个人独立维护，与任何官方社区组织及其维护者无隶属、合作或背书关系，也未使用其 npm scope。

烧 token，养电子宠物 —— 跑在 [magpie](https://github.com/yetone/magpie) 网关上的插件，带侧边栏页面。

统计**所有 magpie 记账的请求**（Claude Code、Codex、Pi、OpenCode、Gemini CLI……不管哪个 agent、是否流式），把 token 喂给当前出战宠物。失败请求不喂。

引擎来自外部依赖 [@jcendal/opencode-digital-pet](https://github.com/jcendal/digital-pet) 0.18.0（Apache-2.0，见 NOTICE），本仓库不 vendored 上游代码、不打包图鉴数据。

**精灵图**：650 只图鉴里有 648 只使用 [sundeth/omnipet](https://github.com/sundeth/omnipet) 的 PNG 精灵帧（CC BY-NC 4.0，© Anderson Porto 2025，见 NOTICE）——497 只取它的高清帧（`monsters_hidef`，54×48），151 只上游只有点阵帧（`monsters`，48×48），一并移植以免再出现文字帧方块；Moonmon、Sunmon 上游两套都没有，只剩文字帧兜底。帧数据经 [@jcendal/digital-pet](https://github.com/jcendal/digital-pet) 间接参考了 [Tortoiseshel's Full Color Digimon Dot Sprites](https://withthewill.net/threads/22970-Full-Color-Digimon-Dot-Sprites)。精灵帧文件随仓库分发（`sprites/` 目录，约 43MB）；仅可用于非商业用途，完整授权与署名见 NOTICE。

> **高清图失踪案（已破案）**：作者花了大力气把宠物捯饬成 16-bit 高清小可爱，却发现整个面板最养眼的核心素材一直在本地独自美丽——`.gitignore` 把 `sprites/` 拦得严严实实，9008 张 PNG 一张都没上车。于是 GitHub 用户喜提「复古马赛克限定版」，作者本人发现后也只能震惊、无奈并捂脸：合着最高清的部分，恰恰是最没上传成功的部分。现已全部补票入库；这次真的让高清宠物出门见人了。

**鼠标交互**（画布上）：抚摸（按住来回划 → 心形粒子 + 亲密）、点击（跳跃）、悬停（注视微光 + 开心帧）、拖拽（拎起来晃 → 开心帧）、双击（转圈 → 走路帧）、快速划过（眩晕星星）。交互时 PNG 帧实时切换表情。

## 界面

- **侧边栏页面**：magpie 窗口左侧导航里的「宠物」页 —— 首屏是宠物栖息地：像素宠物随状态活动，下方是五项状态条（饱食/心情/精力/清洁/亲密）与进化进度条。可以给当前搭档**起名**；标题栏右侧有快速「**出战**」和「**立即刷新**」两个按钮。整页玩法入口：**日常照顾**、三档**探险**、**每日目标**、**装饰收藏**、**图鉴与切换**。
- **设置面板**：magpie → Settings → Plugins → Digital Pet（开关、缓存 token、补录、轮询间隔）
- **养成难度齿轮**（宠物页右上角）：二级菜单六档（极速 ×0.1 / 简单 ×0.2 / 正常 ×0.5 / 普通 ×1 / 困难 ×2 / 漫长 ×5）。齿轮里的「**更多…**」是三级菜单，两项都带确认门槛：**作弊**（×0.01，填充速度是「极速」的 10 倍，点两下才切）和**全宠物获取**（整图鉴 650 只入背包 —— 点一下先问「是否选择获取全部宠物」，再点一下弹出「此举动不可逆」的确认框，框里的确认键要等 5 秒倒计时走完才按得下去）。难度只缩放喂进引擎的经验槽，统计里的 token 始终是真实用量。
- **CLI**：见下

### 图鉴的四个筛选

| 筛选项 | 内容 |
|---|---|
| 只看背包 | 你现在持有的形态（每只伙伴一条；手上的蛋也算一件，显示为 `????`） |
| 查看已解锁 | 所有能点开看的形态：背包里持有的 + 进化史里走过的旧形态（旧形态标「曾持有 · 可展示」，能切出来看，不占背包） |
| 全部图鉴 | 650 只全列 |
| 只看未拥有 | 从没养过的，不给按钮 |

- 图鉴按**物种**合并：同一物种你持有多只（比如两颗蛋）只占一条，标题后挂 `×N`。
- 筛选右边有实时计数：`当前 N 张 · 可展示 M / 共 650 · 持有 K 只`。
- 背包只认**在役那只**和历代伙伴的当前形态；「显示这只」不会把别的物种算进背包。

## 工作方式

```
magpie 网关 ──记账──> /v1/magpie/usage/requests
                          │  每 20s 轮询（route_id 幂等去重）
                          ▼
              本插件（magpie 的 Bun 宿主进程内）
                          │  合成 message.updated 事件
                          ▼
              digital-pet 引擎（原版）──> 用户目录存档（Windows: %APPDATA%\magpie-digital-pet\pet.db）
                          ▲
        侧边栏页面 <── 本地服务 127.0.0.1:3571（读同一库）
```

不走中间件（magpie 的中间件沙箱无 IO、没有定时器，读不了库也起不了服务），不解析响应体（magpie 已经替你把每个请求的 token 数好了，流式也准）。多个宿主进程同时跑 watcher 也安全：引擎按 route_id 去重，SQLite 走 WAL；页面服务固定端口，谁先绑谁服务，端口被短命宿主占着时后来者定期重试接管。

页面右上角的 `↻` 会立刻触发一轮拉取（带并发保护，不会和定时那轮叠），不用等下一个 20 秒。

## 插件行上的标签：为什么会看到「供应商」

插件行上的标签是 magpie 自己算的，不是插件声明的。规则是：能确定它是中间件、请求 hook、Agent、工具或纯页面时挂对应标签；都不是时兜底挂「供应商」（前端就是 `|| "pv"`）。

本插件有一个 `main` 入口（watcher 和 3571 的页面服务都靠它启动），magpie 的几个判定因此都不成立：

```go
middlewareOnly = 有 magpie.middleware && 没有 main
gatewayOnly    = 有 magpie.hooks    && 没有 main
inMagpieOnly   = 有 agent           && 没有 main
```

三个都为假，兜底就落到「供应商」。**这不代表本插件注册了供应商**：

- `plugin list --json` 里它没有 `provides`；
- `plugin-providers.json` 里搜不到它；
- 模型列表里没有它，它不参与路由、不参与计费、看不到任何请求体。

同一个兜底也发生在别处：magpie 自带的 Chat 页面（`page-chat`）同样有 `main`，它的行上也是「页面 · 供应商」。

曾经声明过一个空的 `magpie.middleware` 来换「中间件」标签 —— 那个中间件什么都不做，等于假标签，已撤掉。要真挂「中间件」就得让代码跑进网关沙箱，而它没有 IO 和定时器，这个插件在那儿起不来。

要去掉这个标签只有两条路：删掉 `main`（watcher 和页面服务就都起不来了，插件等于停摆），或者改 magpie 那条兜底规则。两条都不做，所以它一直在 —— 它只是个灰标签，不干活。

## 玩法数值

### 成长与阶段阈值

阈值读的是引擎自己的 `opencode-digital-pet.json` 里的 `stageThresholds`（页面和 CLI 读同一份，**只读不写**）。没配就走引擎默认值。本机当前的值：

| 阶段 | 槽位（token） | 引擎默认 |
|---|---|---|
| egg | 5,000,000 | 5,000,000 |
| baby I | 5,000,000 | 10,000,000 |
| baby II | 10,000,000 | 20,000,000 |
| child | 20,000,000 | 40,000,000 |
| adult | 37,500,000 | 75,000,000 |
| perfect | 62,500,000 | 125,000,000 |
| ultimate | 100,000,000 | 200,000,000 |
| super ultimate | 150,000,000 | 300,000,000 |

- 到阈值那一瞬间，引擎把 `gauge` 截到阈值并开一场进化对决；**超出的部分会被截掉**。
- 待战期间新到的用量照记账，但**不进成长槽**，赢下对决才恢复。
- 蛋（stage 0）到阈值直接变成 baby I，**不经过对决、必定成功**。

### 蛋与孵化

- 管理里「**获取新的蛋**」→ 再点一次确认 → 当前伙伴退役，拿到一颗未知的蛋。
- **唯一的门槛是「孵蛋条件计数器」**：把手上所有 baby II 及以上伙伴的阶段数字加起来（baby II 记 2、child 记 3、adult 记 4……），和上次领蛋时记下的快照比较，**变大了才给一颗**。
  - 计数器只在伙伴**真的进化**（打赢相克试炼）时变大；把退役的成年伙伴反复设为出战不会刷新。
  - 领完立刻快照，所以同一次进化只换一颗蛋，两次进化叠在一起也只算一颗（资格不累积）。
  - 举例：1 只 baby II + 1 只 child → 2 + 3 = 5；只有把某只再往上推一级，才会变成可领状态。
  - 还没有任何伙伴时（全新安装）直接给第一颗。
- 蛋在页面上是未知状态：名字、编号、阶段全是 `????`（图鉴里固定显示 `编号 0-0000 · stage 0 · 蛋`）。
- 蛋喂到 **500 万 token** 孵成 baby I。孵化时若引擎随机挑中的 baby 你**已经养过**，会换成第一只没养过的；整池都养过则保留随机结果。
- 可以在背包里同时持有多颗蛋；它们共用一个图鉴条目，标题挂 `×N`。

### 相克试炼（进化对决）

| 属性 | 克制 |
|---|---|
| 疫苗 Vaccine | 病毒 Virus |
| 病毒 Virus | 数据 Data |
| 数据 Data | 疫苗 Vaccine |

- 到阈值时亮出对手属性，在三种属性里选一个：克制对手即进化。
- 选错：本阶段进度**退回 50%**，并记一次连败；**下一场必胜**。
- 属性数据取自 digimon.net 官方图鉴，`lib/digimon-attributes.json`（650 条；没有三角属性的按「无属性」处理，任选皆胜）。

### 出战锁定

- 管理里「**设为出战**」＝把正在看的那只设成吃经验的伙伴；标题栏右侧也有快捷按钮。
- 引擎只喂 `partner_team.principal` 且未退役的那只，所以换出战会把目标解除退役、原来那只退役。
- 「**恢复默认出战**」＝清掉锁定，回到 generation 最小（第一只）伙伴出战。
- 图鉴的「显示这只」只换立绘和名字，**不改出战伙伴**；面板的 gen / 经验槽跟着展示的那只走。

### 日常照顾

| 操作 | 冷却 | 效果 |
|---|---|---|
| 点心 snack | 连续 4 次后 10 分钟 | 饱食 +10、心情 +2 |
| 玩耍 play | 连续 3 次后 8 分钟 | 心情 +12、亲密 +2、精力 −10（需要精力 ≥ 20） |
| 清洁 clean | 10 分钟 | 清洁直接回 100；清洁度低于 50 时额外 +1 亲密 |
| 休息 rest | 15 分钟 | 精力 +25、饱食 −2 |
| 摸蛋 petEgg | 5 分钟 | 亲密 +2（仅蛋阶段可用） |
| 抚摸 pet | 3 分钟 | 亲密 +2、心情 +1（画布上按住来回划） |

日常照顾标题右上角的「**重置次数**」消耗 **2 个数据碎片**，清空点心和玩耍的已用次数与冷却；其他照顾动作的冷却不受影响。按钮需要点两次：第一次只进入待确认状态，第二次才扣碎片。

自然衰减（每小时）：饱食 −2、心情 −1.5、清洁 −1，**精力 +3**；亲密不衰减。离线按真实时间结算，最多累计 24 小时。

### 探险

| 档位 | 时长 | 数据碎片 | 亲密 | 消耗精力 |
|---|---|---|---|---|
| 短巡逻 patrol | 5 分钟 | **4** | **+3** | 10（需要精力 ≥ 15） |
| 数据原野 field | 15 分钟 | **10** | **+4** | 10（同上） |
| 深夜远征 night | 30 分钟 | **18** | **+5** | 10（同上） |

一次只能进行一场探险；结算时随机附一句见闻，并计入「探险 1 次」的每日目标。

### 每日目标（每天各能领一次）

| 目标 | 条件 | 奖励 |
|---|---|---|
| 照顾 | 当天照顾 2 次 | **4 碎片** |
| 探险 | 当天完成 1 次探险 | **6 碎片** |
| 投喂 | 当天自动吃掉 10 个请求 | **4 碎片** |

### 数据碎片

- **每天最多赚 240 片**（探险 + 每日目标合计），北京时间 0 点按本地日期重置；花掉的碎片不占额度。
- 到顶后再结算探险，实发 0，提示里会写「今日碎片已达上限」。
- 页面「收藏与装饰」里显示 `数据碎片：N（今日 X / 240）`。

### 装饰背景（十五套）

名字是地名式的，不带「背景」后缀；`sunset` 这个 id 沿用历史数据，画面是遗迹。

| 背景 | 价格（碎片） |
|---|---|
| 阳光村落 village | 0（开局自带并装备） |
| 初始原野 meadow | 20 |
| 月见之丘 night | 50 |
| 齿轮草原 gear | 75 |
| 数据神殿 terminal | 80 |
| 网络之海 ocean | 120 |
| 黄昏海岸 coast | 140 |
| 失落遗迹 sunset | 160 |
| 永冬雪原 snow | 240 |
| 幽暗密林 forest | 280 |
| 悬浮隧道 tunnel | 300 |
| 樱之神社 sakura | 320 |
| 废弃工厂 factory | 360 |
| 星海尽头 void | 400 |
| 丑皇暗堡 castle | 520 |

买入即永久解锁，换装免费；背景图在 `page/backgrounds/*.webp`。

### 成就

`first-care`（第一次照顾）、`first-clean`（第一次清洁）、`first-expedition`（第一次探险）、`care-10`（累计照顾 10 次）、`fragments-100`（碎片达到 100）、`first-evolution`（第一次进化）。

## 安装

```sh
magpie plugin add C:\Users\<你>\.config\magpie\plugins\magpie-digital-pet
```

装好即开始记账喂食，侧边栏「宠物」页即开即用。命令行等效操作：

```sh
cd %USERPROFILE%\.config\magpie\plugins\magpie-digital-pet
bun cli\pet-cli.mjs status     # 当前进度、进化百分比（与侧边栏页同源），另附只读养成摘要：
                               # care / bond / fragments / expedition
bun cli\pet-cli.mjs spawn      # 获取新的蛋（当前伙伴会退役）
bun cli\pet-cli.mjs events     # 最近事件
bun cli\pet-cli.mjs partners   # 养过的每一代
bun cli\pet-cli.mjs freeze     # 暂停生长（用量照记，宠物不长）
bun cli\pet-cli.mjs unfreeze
bun cli\pet-cli.mjs set 4-001  # 开发者 cheat：把展示钉在某只上（此时不生长）
```

CLI 只提供只读摘要；日常照顾、探险和装饰装备等写操作请用侧边栏「宠物」页。

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifications` | `true` | 进化/孵化提示写进 magpie 插件日志 |
| `includeCacheTokens` | `false` | cache 命中是否计入。默认不计 |
| `backfill` | `false` | 补录 magpie 已记的 30 天用量（蛋立刻孵化）。改后需重载插件 |
| `pollSeconds` | `20` | 轮询间隔（15–3600s）。改后需重载插件 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 网关地址 |
| `dbPath` | `%APPDATA%\magpie-digital-pet\pet.db`（Windows） | 个人存档路径；默认与插件代码目录分离，更新插件不会动存档。可显式覆盖 |
| `port` | `3571` | 侧边栏页面服务的本地端口 |

## 数据

- 数据库：Windows 默认 `%APPDATA%\magpie-digital-pet\pet.db`（SQLite，WAL，与 CLI / 页面并发安全）；其他平台为 `~/.config/magpie-digital-pet/pet.db`。首次启动会自动从旧版 `<插件目录>\data\pet.db` 迁移，旧文件保留作备份，不删除。
- 养成层新增表都以 `magpie_pet_` 前缀：`care_state` / `care_events` / `expeditions` / `inventory` / `daily` / `fragment_daily`（每日碎片收入）/ `achievements` / `names` / `battle_retries` / `pin`（出战锁定）/ `display_state`（展示覆盖）/ `dev_mode`。
- 轮询游标：存档同目录 `watcher-state.json`（删掉它 + 开 `backfill` 可重算历史）。
- 引擎自己的表（`partners` / `partner_events` / `usage_receipts` / `vpet_*`）语义不改。

## 红线（与策划书一致）

- 不注入任何 agent 的上下文：不注册 hooks/MCP/skills，不写 agent 配置
- 不消耗 token：引擎零 LLM 调用，全部本地规则
- 不改请求：只读 magpie 的用量账本；只读引擎的 `opencode-digital-pet.json`（阈值显示），不写
- 侧边栏页面只绑 127.0.0.1，只服务 magpie 窗口跳来的页面
- fail-open：本插件任何异常都不影响网关

## 测试

```sh
bun tests/pet-frames.test.mjs              # 像素帧提取与加载
bun tests/pet-care-rules.test.mjs          # 照顾状态与主动操作规则
bun tests/pet-progression-rules.test.mjs   # 探险、每日目标与成就规则
bun tests/pet-care-store.test.mjs          # 养成 SQLite 存储（含每日碎片上限）
bun tests/pet-control-state.test.mjs       # 控制状态自愈
bun tests/pet-hatch-pool.test.mjs          # 蛋阶段与孵化池
bun tests/pet-server-care.test.mjs         # 页面 API 与安全
bun tests/page-contract.test.mjs           # 页面结构契约
bun tests/docs-contract.test.mjs           # 文档与 CLI 摘要契约
bun tests/e2e-page.test.mjs                # 真实存档副本端到端；浏览器段见下
bun tests/selftest.mjs                     # 26 项离线自检（假网关 + 临时库 + 页面服务 + 端口接管）
```

端到端测试的核心段始终运行；真实浏览器段只有显式提供本机 Playwright Core 与浏览器路径时才运行，并在临时目录保存截图：

```sh
PET_E2E_PLAYWRIGHT="<playwright-core/index.mjs 绝对路径>" \
PET_E2E_EDGE="<msedge.exe 绝对路径>" \
PET_E2E_ARTIFACT_DIR="<截图输出目录>" \
bun tests/e2e-page.test.mjs
```

## 卸载

```sh
magpie plugin rm magpie-digital-pet
```

个人数据留在用户目录（Windows 为 `%APPDATA%\magpie-digital-pet\`），与插件代码目录分开；想全删手动删除该目录即可。旧版插件目录下的 `data\` 只保留迁移前备份。
