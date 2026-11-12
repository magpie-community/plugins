# magpie-pareto · 性价比图

[magpie](https://github.com/yetone/magpie) 社区插件。它把你在 magpie 里能调用的每个（渠道 × 模型）画成散点：横轴是你在这个渠道上**实际拿到的价格**，纵轴是公开榜单上的**能力分**。用途是按任务给路由组挑选模型。

## 安装

```bash
magpie plugin add github:broven/magpie-pareto
```

装好后，magpie 窗口侧栏的 Plugins 分组里会出现「性价比图」。插件的本地 service 默认监听 `127.0.0.1:3498`，可以在插件 options 里改 `port`。

## 它做什么

- **价格**：取本机 gateway `/v1/models` 返回的生效价，也就是叠加了你在 magpie 里设的价格、插件价和峰谷价之后的结果。input、output、cache 各项按「负载画像」加权，合成一个数。画像可选全部、某个路由组、某个 agent，数据取自最近 30 天的 `usage.jsonl`；也可以改用 3:1、只看 input、只看 output 这几种固定口径。横轴默认用对数刻度，免费模型单独放在最左边一列。送免费额度、按倍率消耗额度的渠道（例如 workbuddy）在 magpie 里通常定价为 0，会落进这一列；列内按「额度倍率」横向排开（0x 在最左，列内最大倍率在最右，未填倍率的最右并标「倍率未知」），在点的操作面板里可以填写或清空倍率。
- **能力**：可选的榜单有：
  - [real-api-pricing](https://github.com/Fei2411/real-api-pricing) 收录的 8 个榜单：AA Intelligence、AA Coding Agent、Terminal-Bench 4.0、DeepSWE、Code Arena 等
  - Epoch AI 的 ECI 和 SWE-bench Verified

  每个榜单单独作为一个维度，不做复合分。
- **点**：每个（渠道, 模型）只画一个点，同一个模型的点用同一种颜色。分数取这个模型在该渠道支持的 effort 里的最高分（各 harness 取最高）；渠道没声明 effort 或榜单没有 effort 维度时取榜单最高分。tooltip 里注明取的是哪档 effort 和哪个 harness。同一模型在不同渠道上的点用实线连接，点旁标 `渠道/模型`（放不下就不画，tooltip 里仍能看到）。图表上方有一排渠道开关，可以按渠道显示/隐藏；隐藏后它的点、无分数条目和跨渠道连线都不画，坐标轴只按可见点计算。每个系列只画最新一代；旧一代只有在比同系列最新一代更便宜时才显示。当前路由组的成员在 tooltip 里列出。
- **颜色**：每个厂商（Anthropic、OpenAI、Google、DeepSeek 等，按模型 id 前缀识别）一个固定色相，同厂商的系列在该色相附近取变体，同一系列的新旧代同色，未知厂商用低饱和灰系。点、跨渠道连线、tooltip 和图例统一用系列色；图例按厂商分组列出当前全部可见系列，不截断。
- **名称匹配**：优先级是人工映射 > 规范化后的模糊匹配 > LLM 判断。「名称匹配」面板列出当前榜单下没有匹配到任何榜单模型的 magpie 模型（按模型 id 去重并注明渠道），可以直接填榜单模型名保存成人工映射；已有人工映射可以删除。LLM 判断要先在下方选一个 magpie 模型才会启用，它给出的结果用虚线描边标出，需要你确认。没有分数的模型放在图底部的「无分数」带里，可以手动打分。在匹配表里或点操作面板里可以把某个模型从图上隐藏（按 magpie 模型 id，对所有渠道生效）：隐藏后它的点、无分数条目、跨渠道连线和未匹配条目都不画，坐标轴只按可见点计算；「名称匹配」区域会列出已隐藏的模型及其渠道，点「恢复」放回来。
- **订阅计算器**：订阅的额度可以按四种口径填写：等值美元、token 额度、每个时间窗的请求数、积分 × 每个模型的倍率。real-api-pricing 收录了的套餐可以直接预填。插件把订阅折算成渠道折扣率，确认价格 diff 后，用 `magpie model price` 写回 magpie。
- **写回路由组**：在点上把这个模型设为某个路由组的成员，确认后执行 `magpie group set`。

插件不计算 Pareto 前沿，最优解靠你自己看图判断。

## 数据来源与署名

- [real-api-pricing](https://github.com/Fei2411/real-api-pricing)（MIT）：榜单分数和套餐额度。其中 AA 系列榜单的数据来自 [Artificial Analysis](https://artificialanalysis.ai)。
- [Epoch AI Benchmarking Hub](https://epoch.ai/data)（CC-BY 4.0）
- [models.dev](https://models.dev)：官方价格和模型元数据

## 开发

```bash
bun install
bun run e2e          # 端到端：测试数据 + 沙箱里的真实 magpie CLI 写回，最后一行应为 E2E PASS
bun run ui-shot      # 截图到 artifacts/，需要本机装有 Chrome
bun run frame-check  # 按 magpie 窗口的方式（sandbox iframe + 页面 CSP）加载，确认能连上 service
magpie plugin add "$PWD"  # 本地安装；改完代码再 add 一次即可重载
```

设计细节见 [DESIGN.md](DESIGN.md)。
