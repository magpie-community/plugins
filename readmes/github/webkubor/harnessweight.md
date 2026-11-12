<p align="center">
  <picture>
    <source srcset="brand/assets/lens-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="brand/assets/lens.svg" width="96" alt="HarnessWeight">
  </picture>
</p>

<h1 align="center">HarnessWeight</h1>

<p align="center">给网关后面的每个 <b>agent harness</b> 称重：读了多少 token、命中多少缓存、失败多少次、每轮重发多重的工具定义。</p>

<p align="center">
  <a href="https://github.com/magpie-community/plugins/tree/main/packages/page-harnessweight"><img alt="magpie 社区版" src="https://img.shields.io/github/package-json/v/magpie-community/plugins?filename=packages%2Fpage-harnessweight%2Fpackage.json&label=magpie%20%E7%A4%BE%E5%8C%BA%E7%89%88&color=17A9A2"></a>
  <a href="package.json"><img alt="版本" src="https://img.shields.io/github/package-json/v/webkubor/harnessweight?label=%E6%9C%AC%E4%BB%93%E7%89%88&color=2B2F36"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/github/license/webkubor/harnessweight?label=%E8%AE%B8%E5%8F%AF&color=2B2F36"></a>
  <img alt="零运行时依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-17A9A2">
  <img alt="只在本机运行" src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-%E5%8F%AA%E5%9C%A8%E6%9C%AC%E6%9C%BA-F26B1D">
  <img alt="中文 / English" src="https://img.shields.io/badge/%E7%95%8C%E9%9D%A2-%E4%B8%AD%E6%96%87%20%2F%20English-FFB547">
</p>

<p align="center"><b>中文</b> · <a href="#english">English</a></p>

![HarnessWeight 浅色主题](docs/preview-light.png)

https://github.com/user-attachments/assets/866f1b60-b5c6-4128-8828-15646b10a32e

> ▶ 30 秒演示：结论 → Agent 卡片 → 排序 → 详情 → 切 30 天 → 深色。

> 截图是作者本机 7 天的真实用量，在和 magpie 一样的沙箱框架里实拍，没有模拟数据。Agent 名字和图标与 magpie 自己显示的一致。卡片上的小图标是该 Agent 在这段时间实际用到的模型，超出排序的部分渐隐。

## 它回答什么问题

你同时用 Claude Code、Codex、zcode、DSH、Cursor……都接在同一个 magpie 网关上。magpie 自带的用量页按**模型**统计；HarnessWeight 按 **agent harness** 统计，回答四个问题：

- **谁在花你的 token**：每个 Agent 读进模型的总 token，其中多少命中缓存、多少按原价。
- **谁每次读得最多**：每次请求的平均输入。上下文越大，越贵。
- **谁最不稳**：失败率、首字延迟和总耗时（p50）。失败的请求也可能消耗 token。
- **谁的工具清单最重**：Agent 每轮都会把整份工具定义重发一遍，HarnessWeight 在网关上量出它有几个、多大。

页面顶部直接给出几句结论，例如「dsh 占了这段时间 87.9% 的输入 token」「mimocode 的失败率是 10.5%」。

<details>
<summary>深色主题</summary>

![HarnessWeight 深色主题](docs/preview-dark.png)

</details>

## 安装

```sh
magpie plugin add @magpie-community/page-harnessweight
# 或直接装本仓最新版：magpie plugin add github:webkubor/harnessweight
```

装好后，magpie 侧栏「插件」里会多一个「HarnessWeight」页。历史数据马上能看到，因为它读的是 magpie 已有的用量记录；工具定义重量从安装后的下一次请求开始采样。

## 工作方式

```
magpie usage.jsonl ─────────────┐
                                ├─► 本地服务 127.0.0.1:3496 ─► 页面
网关 hook（只读）─► tools.jsonl ─┘
```

| 部分 | 文件 | 做什么 |
|---|---|---|
| 网关 hook | `harnessweight.hooks.mjs` | 请求完成后记下 Agent 名、模型、工具的个数、字节数和名字、token。**不改请求，不记对话内容、参数和凭证**；出错也不影响请求。 |
| 用量读取 | `lib/usage.mjs` | 增量读取 magpie 的 `usage.jsonl`，几百 MB 的文件也只读新增部分；内存里保留 31 天。 |
| 本地服务 | `service.mjs` | 只监听 127.0.0.1，提供界面和 `/api/summary`。 |
| 带路页 | `page/` | magpie 的插件页沙箱禁止联网，只能把自己导航到本地服务，顺便带上主题和语言。 |
| 界面 | `app/` | 采集状态、结论、总览、Agent 卡片、可排序的对比表、工具重量、详情抽屉；支持浅色、深色和手机宽度。 |
| 名字与图标 | `lib/brands.mjs`、`app/icons/` | 从网关 `/v1/magpie/usage` 取每个 Agent 的显示名和图标名，和 magpie 侧栏一致；没有图标的显示首字母。 |

### 口径说明

- **输入 token** = 未缓存输入 + 缓存读取 + 缓存写入；**按原价** = 未缓存输入 + 缓存写入。
- **失败**：HTTP 状态为 0、≥400，或记录里带错误。499（客户端主动取消）单独计，不算失败。
- **工具 token** 按 JSON 每 token 约 3.5 字节估算，不是精确计数；各 Agent 口径一致，可以互相比。
- 脚本、SDK 和 magpie 内部请求（curl、python-urllib、magpie 自身探测等）默认不计，勾选「含脚本和内部请求」可以显示。

### 选项

写在 `plugins.json` 里该插件的 `options`：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3496` | 本地服务端口 |
| `usageLog` | `~/.config/magpie/usage.jsonl` | magpie 用量记录的位置 |
| `dataDir` | `~/.config/magpie/harnessweight` | 工具采样存放目录 |
| `agents` | `[]` | 只采样这些 Agent；空表示全部 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 取 Agent 名字和图标用的网关地址 |

## 图标来源

`app/icons/` 是 magpie 为各 Agent 显示的同一套图标，取自社区插件 page-agent-office（MIT），品牌图形来自 [@lobehub/icons](https://github.com/lobehub/lobe-icons)（MIT）。各标志归其所有者，只用来标明对应的 Agent，详见 `app/icons/NOTICE`。

## 隐私与安全

数据只在本机读取，不上传，没有遥测。本地服务只监听 127.0.0.1，并且：每次启动生成随机口令，只写进界面 HTML（该 HTML 不带 CORS 头，其他网页读不到），所有 `/api/` 请求都要带上它；校验 Host（防 DNS 重绑定）和 Origin；只接受 GET。hook 写下的每一行只有名字和数字；测试里专门断言了提示词内容不会落盘。

## 任务平均完成时间

Harness 卡片、总览表和详情会显示任务平均完成时间，以及旁边的**有效完成任务数**。较低值为绿色，较高值为红色；只有一个有效值、全部并列或没有有效样本时不标极值。不同任务的复杂度可能不同，这个均值不是统一题目的性能跑分。

- **任务边界**：一次用户提示触发的执行周期，从开始信号到成功完成信号，包含期间的模型请求、工具执行和等待。它不代表业务验收，也不等于单次 HTTP/LLM 响应或会话总寿命。
- **计算方式**：有效完成任务的完整墙钟耗时之和 ÷ 有效完成任务数。重复事件去重，并行任务按独立关联 ID 隔离；未完成、失败、取消、缺失开始或结束、时间倒置及冲突事件不计入平均值。
- **周期**：按任务完成时间归入所选窗口。沿用页面现有口径：“今天”为过去 24 小时，7 天/30 天为滚动窗口；跨窗口开始、窗口内完成的任务保留完整耗时。
- **空态**：“未接入或本周期无任务数据”表示没有观测到该窗口的任务边界，不能仅凭它断言 hook 没安装；“无有效完成样本”表示有任务事件但没有可计入的成功任务。两者均显示 `—` 和 0 个有效完成任务，API 平均值为 `null`。没有网关请求的 Harness 仍可展示任务遥测。
- **保存范围**：本机 `tasks.jsonl` 及上一代轮转日志，最多保留 30 天，两个日志总计最多约 16 MiB。容量轮转也可能提前丢失边界，因此这是已观测完整样本的均值，不保证所有任务都被采集。不会回填历史使用日志。

### Codex 自动读取

自动只读 `~/.codex/sessions/` 的 `rollout-*.jsonl`，不安装 hook、不修改 Codex 日志，也不保存提示词或响应。只计入可核实为用户主会话、触发来源为 `user` 或 `composer`，且有 `task_started` 和无错误 `task_complete` 的 turn；子 agent、自动触发、未知来源、中止和未完成 turn 均排除。样本单位是用户 turn，不能证明包含提交前排队时间，也不代表用户目标完成。

优先采用 Codex 的 `duration_ms`；缺失时使用同一 turn 的 `started_at` / `completed_at` 秒级差值，API 的 `precision` 给出精度计数。按秒级 `completed_at` 归入周期，不用外层日志写入时间；周期边界的时间精度为秒。历史回放按原 turn 去重，冲突边界或任一失败记录排除整个 turn；合成导入 ID 按 session 区分。需要可核验的会话来源和 turn 归因，旧版或导入日志缺失这些字段时不计入，因此覆盖并非完整历史。读取器按文件增量读取，定期发现文件，并合并并发页面的读取。损坏 JSONL、过长单行（超过 8 MiB）或权限等读取错误会令 Codex 任务计时显示暂不可用；API 的 `sources.codexReadIssues` 仅记录错误种类和数量，其他指标继续显示。不保存或返回错误正文。24 小时、7 天和 30 天均为从当前时刻向前的滚动窗口，页面日期使用本地时区。

2026-11-11 真实本机验证：近 7 天共 53 个有效用户 turn，平均 655,763 ms（约 10 分 56 秒）。[总览截图](docs/task-duration/codex-real-local-7d.png)与[详情截图](docs/task-duration/codex-real-local-detail.png)均标注真实来源和排除口径；[验证记录](docs/task-duration/validation.json)的 `codexRealLocalReview` 保存三周期数值。截图服务仅读取本机 Codex 日志，其余日志源隔离为空，未向用户日志写入样本。

### Cursor 可选接入

当前提供 Cursor 的 `beforeSubmitPrompt` → `stop` 适配器，依据 [Cursor 官方 hook 规范](https://cursor.com/docs/hooks)；按 `conversation_id` + `generation_id` 关联一次执行周期。只有 `status=completed` 计入，`aborted` / `error` 排除；自动续跑 `loop_count>0` 的终止信号标为不明确并排除。时间取本地命令实际观测 hook 的时间，包含命令调度误差。不会通过 SessionStart/SessionEnd 或空闲间隔猜测任务结束。

安装 HarnessWeight **不会自动修改 Cursor 配置**。先确认目标 Cursor 版本支持这些 hook，并核对它在 Magpie 中的实际 agent ID，以及 HarnessWeight 正在使用的 `dataDir`。不能把 CLI 可执行文件名直接当成网关 ID。没有可核实的 ID 时应保留未接入状态。

采集命令位于安装包的 `bin/task-event.js`。它也提供只读配置预览：读取现有 JSON，保留其他事件、命令和字段，幂等追加开始/结束命令，输出合并后的配置；不会安装或写回配置。示例中的三个变量需先填写实际值：

```bash
# 在最终安装的 HarnessWeight 目录执行；不要使用稍后会删除的临时 worktree 路径。
node bin/task-event.js \
  --print-cursor-config "$CURSOR_PROJECT_DIR/.cursor/hooks.json" \
  --agent "$CURSOR_GATEWAY_ID" \
  --data-dir "$HARNESSWEIGHT_DATA_DIR" \
  > /tmp/harnessweight-cursor-hooks.review.json
```

审阅预览后，将新增 hook 与目标配置合并；**不要把标准输出直接重定向覆盖输入的 hooks.json**。优先明确目标项目范围；用户级或受管 hook 会影响其他任务，应由用户决定。预览使用绝对 Node 和脚本路径，安装位置变化后需重新生成。停止 hook 的 `loop_limit: null` 确保续跑事件也能被观测，采集器本身不请求续跑。已有 hook、异步设置、插件与自动续跑策略仍需结合实际环境确认。

正常 hook 执行无标准输出，采集失败会跳过并保持任务运行；不保存提示词、响应、文件路径或原始会话 ID，只记录哈希关联键、阶段和时间。服务或采集命令重启后仍可读取已落盘边界；新执行不能重用旧任务 ID。启用后等待自然发生的真实用户任务验证，不需要为指标触发付费测试任务。

### 其他 Harness 与 API

Claude Code、Grok 等尚未提供内置任务生命周期适配器；这不代表它们没有 hook 能力。通用 `task-events-v1` 协议可以由已核实的真实生命周期接入：

```json
{"version":1,"agent":"gateway-agent-id","runId":"unique-execution-id","taskId":"unique-task-id","event":"started","atMs":1794391200000}
```

向 `node bin/task-event.js --source protocol --data-dir /absolute/data/path` 的标准输入发送该结构；阶段为 `started`、`completed`、`failed`、`cancelled`。`atMs` 必须是原始事件的 Unix 毫秒时间；重试保留原 ID 与原时间戳，新执行使用新 `runId`，同一执行中的每个任务使用不同 `taskId`。只有确为同一任务的恢复执行才可继续用原 ID。每个执行周期使用一种采集来源，避免人为重复接入。不能把网关请求开始/结束事件映射为任务。

`GET /api/summary` 的 `agents[].taskDuration` 提供 `averageMs`、`totalMs`、`samples`、`available`、`coverage`、`reason`、`sources`、`metricSource` 与 `excluded`。顶层 `taskTiming` 给出执行周期边界、按完成时间筛选的口径、实际时间窗口、保留限制和支持的适配器。没有有效完成样本时 `averageMs` / `totalMs` 为 `null`；采集文件读取失败单独降级为 `reason=read-error`，不影响其他可读来源。同一 Harness 存在不同来源的有效完成样本时，边界不确定，`reason=mixed-sources` 且不提供合并平均值；只有单一来源有有效完成样本时 `metricSource` 指明该来源。不同来源按组展示，不标优劣。

页面顶部分别显示请求日志、工具日志、任务事件日志和 Codex 有效完成轮次的最近观测与读取状态；任务两路仅覆盖保留窗口的近 30 天。`telemetry` 提供对应的 `state` 与最近时间。`missing` 表示日志文件未找到，`no-events` / `no-completions` 表示未观测到可用记录，`read-error` 表示读取失败；它们均不等价于判定 hook 是否安装。页面数据生成时间与记录到达时间分别显示。单一路径读取失败时，不展示该来源的旧缓存，其他来源继续显示并提示降级。

## 开发

```sh
npm test      # 四种协议的工具解析、用量解析、汇总、增量读取、hook 不落内容
npm run dev   # 直接起服务：http://127.0.0.1:3496/
```

## 品牌

| Token | 色值 | 用法 |
|---|---|---|
| teal | `#17A9A2`（渐变 `#5EE0D2`→`#17A9A2`） | 主色、缓存命中 |
| orange | `#F26B1D`（渐变 `#FFA23A`→`#F26B1D`） | 只标「花得最多」的那一个 |
| yellow | `#FFB547` | 标识的重叠处 |
| graphite | `#2B2F36` | 标识底层、按原价的部分 |

标识是三片镜片叠在一起，代表网关后面的几个 Agent，叠在一起的地方就是对比。源文件和评审页在 [`brand/`](brand/)。

## 状态

v0.5.0。原名 Agent Lens，因与多个同名项目撞车，在 0.4.0 改名为 HarnessWeight；旧的 GitHub 地址会自动跳转，已有的工具采样会自动迁移。0.5.0 新增：供应商 × Harness 稳定性报告（按供应商查看各 Harness 的请求、失败与主动取消，品牌图标沿用本机 magpie 配置）、Agent 卡片上的模型图标（按实际用量排序、超出渐隐）、页面顶部按来源分开的采集状态（请求日志 / 工具日志 / 任务事件 / Codex 轮次），以及任务耗时的来源与空态说明（Codex 显示「平均已完成用户轮次耗时」，未接入生命周期采集器的 Harness 显示 `—` 而不是 0）。

---

<a id="english"></a>

## English

**HarnessWeight** is a [magpie](https://github.com/yetone/magpie) plugin that weighs every
**agent harness** running behind your gateway — Claude Code, Codex, ZCode, Cursor,
DeepSeek Harness — **by agent, not by model**.

magpie's own usage page groups by model. Model pricing tells you what a token costs.
Neither tells you how many tokens your *harness* burns before the model reads a single
word: every harness re-sends its whole `tools` array on every turn, billed as input,
every request, for the whole session. Only the gateway can see that.

### What it measures

| Column | Where it comes from |
|---|---|
| Input tokens, output tokens, cache hits, tokens at full price | the gateway's own usage ledger |
| **Tool definition weight** — how many tools per request, how many bytes, how many tokens, and what share of the input they are | a read-only `magpie.hooks` plugin measuring the `tools` array on every request |
| Failure rate, p50 latency, p50 time-to-first-token | the usage ledger |
| Agent display names and icons | magpie's own agent registry, so they match your sidebar |

### Measured on a real gateway (7 days, 83,420 requests)

- **Claude Code re-sends 36,487 tokens of tool definitions per request — 25.8% of every
  token the model reads.** DeepSeek Harness sends *more* tools (58 vs 44) for 13,117
  tokens, i.e. 5.9% of its input. Tool count is a bad proxy for tool cost.
- Cache hit rate ranged from 94.4% (Claude Code) to 77.2% (Claude Desktop) on the same
  gateway — a bigger lever than any tool tuning.

Full method, all seven harnesses and the caveats:
**[docs/benchmark.md](docs/benchmark.md)**.

### Install

```sh
magpie plugin add @magpie-community/page-harnessweight
```

Zero runtime dependencies. The local service binds 127.0.0.1 only, generates a random
token per start, and validates `Host` and `Origin`. It reads nothing outside your
machine and sends nothing out. A read-only hook records tool names, counts, byte sizes
and token numbers — never prompts, arguments or credentials.

### Privacy

Everything is read locally; there is no telemetry and no network egress. The
`permissions: []` plugin bridge is declared empty and a test asserts the page makes no
network request of its own.

## 社区收录

- 已合入社区仓：[magpie-community/plugins#922](https://github.com/magpie-community/plugins/pull/922)（2026-11-10，合并提交 `186b642`），可用 `@magpie-community/page-harnessweight` 安装
- 登记条目：`registry.json` 里的 `@magpie-community/page-harnessweight`
- 社区 README 的 Pages 和 Gateway hooks 两张表各有一行

MIT © webkubor

## 对比极值与供应商报告

「逐项对比」按列标出极值：缓存命中率越高越优；输入消耗、失败率、耗时和工具重量越低越优。最优为绿、最差为红，并带文字标记。请求量、输出量和会话跨度只标最大/最小；并列同色，全列相同及缺失测量不标色。

「供应商 × Harness 稳定性」读取用量日志的 `provider`，可选择供应商和模型，查看各 Harness 的请求数、失败数、失败率、取消数与最常见错误。点击 Harness 名称查看错误分类及其占失败请求的比例，再点「全部 Harness」回到供应商总览。缺少供应商字段的旧记录归入「供应商未知」。

供应商品牌优先沿用当前 magpie 数据目录里的 `providers.json` / `plugin-providers.json` 显示名称与图标配置。自定义 `file:` 图标从同目录的 `icons/` 读取并内嵌到本机页面；配置更新或图标删除在下一次数据刷新时生效。只把当前报告中的供应商名称和图标传给页面，不传凭据、上游地址或其他配置，不请求外部图标 URL。没有有效本地图标时使用内置品牌兜底，仍没有则显示首字母。自定义图标不打包进公共仓库。

错误分类覆盖限流、额度、鉴权、模型不可用、上下文超限、超时、服务端、请求参数和网络错误；分类根据状态码及错误文本推断，原始错误消息、账户和主机信息不会进入报告。失败率沿用总览口径：失败次数 / 所有请求，499 主动取消单列且保留在分母中。

点击「截图模式」可冻结并单独展示当前报告，保留品牌、时间范围（含时区）、模型筛选、样本量与统计说明。点击退出或按 Escape 恢复页面。该功能分析本机实际使用记录；受控供应商压测需要另行统一任务、模型和请求配置。
