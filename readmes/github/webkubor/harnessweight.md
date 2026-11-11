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

> 截图是作者本机 7 天的真实用量，在和 magpie 一样的沙箱框架里实拍，没有模拟数据。Agent 名字和图标与 magpie 自己显示的一致。

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

v0.4.0。原名 Agent Lens，因与多个同名项目撞车，在 0.4.0 改名为 HarnessWeight；旧的 GitHub 地址会自动跳转，已有的工具采样会自动迁移。

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

错误分类覆盖限流、额度、鉴权、模型不可用、上下文超限、超时、服务端、请求参数和网络错误；分类根据状态码及错误文本推断，原始错误消息、账户和主机信息不会进入报告。失败率沿用总览口径：失败次数 / 所有请求，499 主动取消单列且保留在分母中。

点击「截图模式」可冻结并单独展示当前报告，保留品牌、时间范围（含时区）、模型筛选、样本量与统计说明。点击退出或按 Escape 恢复页面。该功能分析本机实际使用记录；受控供应商压测需要另行统一任务、模型和请求配置。
