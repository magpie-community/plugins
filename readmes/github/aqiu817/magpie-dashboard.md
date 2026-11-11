# magpie-dashboard

为 [Magpie](https://usemagpie.ai) 提供一个 **sub2api 风格的用量仪表盘**：侧栏独立窗口页面，包含统计卡片、周期对比柱图和模型分布排名。零依赖、零构建，纯 HTML/CSS/JS。

English documentation: [README.en.md](README.en.md)。

## 安装

- 在 Magpie 插件页搜索 **magpie-dashboard**（GitHub/npm 双通道发现），或
- 本地文件夹安装：`magpie plugin add <本目录路径>`。

权限声明：`usage:summary`（用量汇总）。插件**不会**接触密钥、登录信息或请求内容——magpie 页面沙箱本身也不允许。

## 功能

- **统计卡片 × 8（两排）**：
  - 第一排·用量：调用数、错误数（环比）、Token 用量、费用；
  - 第二排·洞察：成功率（状态色圆环）、日均调用、平均每次费用（附 Token/次）、活跃模型（附 Top 模型占比）；
  - 全部带环比涨跌（较 7 天 / 30 天日均）与数字补间动画（尊重 `prefers-reduced-motion`；rAF 不可用的 webview 中直接落最终值）。
- **周期对比柱图**：今日 vs 7 天日均 vs 30 天日均，可按调用 / Token / 费用切换维度，柱体带悬浮提示。
- **模型分布**：环形占比图（Top 5 + 其他，中心显示周期总量）+ Top 20 排名列表，色彩阶梯与环形图一致，可按调用 / Token / 费用切换。
- **加载骨架屏**：读取期间显示 shimmer 骨架，数据到达后替换。
- **自动刷新**：页头时钟按钮开关，每 30 秒静默刷新，开关状态通过 `magpie.options` 持久化。
- **更新时间戳**：页头显示「更新于 HH:MM:SS」，每次读取后刷新。
- 明暗主题、语言（中/英）自动跟随 magpie（bridge 注入的 `--magpie-*` 变量与 `theme.lang`）。
- **紧凑密度**：13px 基准，整体尺寸按 magpie 内置用量页的密度校准；柱图限宽居中，宽窗口下不再被等比放大。

## 与 sub2api 仪表盘的对应关系

| sub2api 元素 | 本插件实现 | 说明 |
|---|---|---|
| 独立管理后台（AppLayout + 侧栏） | `magpie.page` 窗口页面，出现在 magpie 侧栏 | magpie 插件页面机制 |
| 统计卡片区（8 卡） | 统计卡片：调用、错误+成功率、Token、费用 + 衍生洞察 | 数据源 `usage:summary` 仅网关调用口径（见数据口径） |
| DateRangePicker（任意日期范围） | 今日 / 7 天 / 30 天切换器（「累计」档自动探测） | bridge 白名单，见数据口径 |
| TokenUsageTrend 逐日折线 | 周期对比柱图（今日 vs 7 天日均 vs 30 天日均） | magpie 无逐日时间序列 |
| ModelDistributionChart 模型分布 | 环形图 + Top 20 模型排名（调用/Token/费用三维度） | `usage:summary` 返回前 20 模型 |
| Top 12 用户消费榜 | 无对应实现 | magpie 无用户维度数据 |
| 近期用量表 | 无对应实现 | magpie 无逐条用量记录 |
| 服务账号卡 | 无对应实现 | providers:list 仅 id+name、无用量维度（模型用量又剥掉了供应商前缀），无法按用量排序，该区块已移除 |
| 快捷操作卡 | 无对应实现 | — |
| Chart.js | 手写零依赖 SVG 柱图（`page/charts.js`） | 沙箱 CSP 禁止外链 CDN |
| Tailwind dark mode | `data-theme` + `--magpie-*` CSS 变量自适应 | bridge 注入，跟随 magpie 主题 |

## 数据口径（bridge 能给什么、不能给什么）

以下均按真实 magpie 安装验证过，改动数据层前先读一遍：

- 插件在加载时一次性读取 `today` / `7d` / `30d`（以及探测 `all`）四档汇总；周期切换不重新请求。
- 「7 天日均 / 30 天日均」= 周期总量 ÷ 天数；柱图中的柱即日均口径。
- `usage:summary` 返回 `{ period, since, calls, errors, input, output, cacheRead, cost, models: [{ model, calls, input, output, cost }] }`。
  - **Token 用量 = input + output + cacheRead**（magpie 上报的全部 token 字段之和，页脚有口径说明）。
  - **费用为 magpie credits 原值**（非美元），卡片标签标注单位；若希望换算成其他单位，改 `page/app.js` 的 `fmtCredits` 一处即可。
- **仅网关口径**：`usage:summary` 只统计**经过 magpie 网关**的调用；magpie 内置用量页的「全部请求」= 网关调用 + **本地会话日志调用**（不走网关的也算），实测可相差数倍。页面页脚已注明此差异。
- **period 白名单**：插件页面只允许请求 `today / 7d / 30d`，其他值被宿主拒绝（`no period %q: today, 7d or 30d`）。插件仍会在每次加载时探测 `period: "all"`——未来 magpie 一旦放开，**「累计」档会自动出现并成为默认**（日均按 `since` 折算天数）；在那之前页面自动回退 30 天，零报错。
- **每供应商用量无法还原**：`models[].model` 被剥掉第一段供应商前缀（如 `rina/kimi-3.7-amphoreus` → `kimi-3.7-amphoreus`），不同供应商的同名模型各占一行但无供应商标识——模型用量无法归回供应商。曾据此做过「供应商排行」区块，因无法按用量排序而移除；若未来 bridge 提供 provider 维度，可按「token 降序 + 右侧显示 token」恢复。

## 目录结构

```
magpie-dashboard/
├── package.json          # magpie.page + permissions，零依赖
├── plugin.mjs            # 空插件导出（宿主要求），页面由 magpie.page 声明
├── page/
│   ├── index.html        # 仪表盘页（无内联脚本，全 <script src>，沙箱合规）
│   ├── style.css         # --magpie-* 变量 + sub2api 卡片风 + 骨架屏
│   ├── charts.js         # 零依赖 SVG：周期对比柱图 + 占比环形图
│   ├── app.js            # bridge 数据层 + 渲染 + 自动刷新 + 中英文案
│   └── icon.svg          # 侧栏标签图标
└── demo/
    ├── assemble-preview.mjs  # 产物生成器：demo 模式重生成 demo.html；fragment 模式出内联片段
    ├── demo.html             # [生成] 实例网页：双击即可在浏览器预览（mock 数据）
    └── mock-bridge.js        # 模拟 magpie bridge（ready/theme/onTheme/options/read）+ mock 数据
```

## Demo

`demo/demo.html` 由 `demo/assemble-preview.mjs` 从 `page/index.html` 生成（勿手改）：双击用浏览器打开，同一份页面代码 + mock bridge（内置四档周期 mock 数据），右下角可切换明暗主题。真实效果以 magpie 内加载插件为准。

## 边界

- 沙箱内无 fetch / 无存储 / 无内联脚本，一切数据来自 `magpie.read` 白名单接口与 `magpie.options`。
- 不做 usage 页替换（`replaces`）、不做面板（panels）、不做快照历史。
- 数字补间不依赖 rAF 的可用性：某些内嵌 webview（窗口被遮挡 / 离屏合成）不调度 rAF，此时数值直接落最终值。

## License

[MIT](LICENSE)
