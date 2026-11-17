# 竞技榜 · magpie-leaderboard

一个 Magpie 页面插件：把前沿模型的综合能力、价格与速度，和
同一批开源模型在不同 coding-agent harness 下的真实表现放进同一个界面。

页面运行时不联网，所有数据随包发布，打开即看。数据来自两个独立信源：

- **模型侧**：[Artificial Analysis](https://artificialanalysis.ai/zh) —— Intelligence Index、
  Frontier Code、Terminal-Bench、AutomationBench、Omniscience、价格、输出速度等
- **Agent 侧**：[Harness Leaderboard](https://huggingface.co/spaces/joelniklaus/harness-leaderboard) ——
  同一模型、同一权重与推理强度下，不同 coding-agent harness 的 overall 分、通过率、
  置信区间、每次通过成本与耗时

> 两个榜单口径不同，分数不能跨榜相加或直接排序。页面里也明确分了「模型榜」和
> 「Agent 战场」两个视图。

## 页面内容

- **总览**：榜首/最强开源/最佳组合、综合智能 Top 12、开源阵营、智能 × 成本散点、
  每个模型的前三套 Agent 外壳
- **模型榜**：58 个去重后的模型，支持搜索、开源/闭源、厂商筛选与六种排序；
  点击任意行打开完整指标面板
- **Agent 战场**：选择四个开源模型之一，查看 10 套 harness 的模型内 overall 排名、
  95% 置信区间、通过率、成本、耗时；全景热力图用**跨模型可比的通过率**着色，
  可点击切换模型；另有 Terminal-Bench 2.1 与 Deep-SWE 拆分

## 装上

把仓库克隆到本地后，插件目录就是仓库根目录（含 `package.json` 的 `magpie` 字段）：

```bash
git clone https://github.com/Weidows/magpie-leaderboard.git
magpie plugin add ./magpie-leaderboard
```

或在 Magpie → Plugins → Add a plugin 里选择本目录。装好后侧边栏会出现「竞技榜」页面。
发布到 npm 之后也可以直接按包名安装：

```bash
magpie plugin add magpie-leaderboard
```

浏览器直接预览页面也可以，但 `_magpie/bridge.js` 会 404（宿主注入的文件），不影响页面；
正式环境由 Magpie 提供主题与选项持久化。

## 刷新数据

```bash
npm run sync          # 同时刷新两个信源
npm run sync:aa       # 只刷 Artificial Analysis
npm run sync:harness  # 只刷 Harness Leaderboard
```

同步结果会重写：

- `page/data-aa.js` —— `window.AA_DATA`
- `page/data-harness.js` —— `window.HARNESS_DATA`

这两个文件是构建产物，**不要手改**；页面通过普通 `<script>` 加载它们（沙盒不支持
ES module 的跨文件 import）。

### 口径

- AA：按 `release.slug` 去重，同一模型只保留 Intelligence Index 最高的那个推理档位；
  价格取公开列表价，混合价按 **3 份输入 + 1 份输出**（75% / 25%）计算。
- Harness：取每个模型 `efforts._all` 的聚合结果（跨 effort 的汇总）。
  `overall` 是上游的 **模型内** 复合分：50% 性能（通过率 / 本模型最好通过率）+
  50% 成本效率（本模型最便宜成本 / 该 harness 成本），所以不能跨模型比较；
  跨模型只比较 `rate`（任务通过率的宏平均）。名次相同的 harness 在页面上用 `=` 标出。
- 噪声：页面底部展示上游的重跑翻转率与换 harness 翻转率；1–2 分的差距不应被当成结论。

## 开发与测试

```bash
npm test
```

测试覆盖：

- 两份快照的结构、排序、去重与数值范围
- 混合价格公式、开源计数
- 上游 Next.js flight 数据的解析、JSON 提取
- `transformAa` / `transformHarness` 的纯函数行为
- `page/app.js` 语法

页面是零运行时依赖的经典脚本 + 手绘 SVG 图表，没有构建步骤。

## 发布到 npm

包名已经存在占位版本时，可以直接配置 GitHub Actions 可信发布；如果包名还没发布过，
先用 token 手动发一次，再配置可信发布。

### 首次配置（本机执行一次）

```bash
npm test
npm login

# 绑定 GitHub Actions 作为可信发布者
npm trust github magpie-leaderboard --file publish.yml --repo Weidows/magpie-leaderboard --allow-publish

npm trust list magpie-leaderboard
```

- `--file` 只写 workflow 文件名，文件位于 `.github/workflows/publish.yml`
- `--repo` 使用 `owner/repo`
- `--allow-publish` 允许该工作流执行 `npm publish`；如需 `npm stage publish`，
  再加 `--allow-stage-publish`
- 可信发布要求 npm CLI ≥ 11.5.1，workflow 使用 Node 24 自带的 npm

### 后续发版

当前 `package.json` 已经是 `0.1.0`，可以直接发。以后按需 `npm run sync` 刷新数据、
改版本（`npm version patch`、`minor` 或 `major`）并 push，然后在 GitHub 创建
Release（或手动运行 “Publish to npm” workflow）。workflow 会先跑测试，再通过
OIDC 发布，无需 `NPM_TOKEN`，并自动附带 provenance。

> 从私有仓库发布时 npm 不生成 provenance；本仓库是公开仓库，因此正常生成。

`package.json` 的 `files` 只包含 `page/`、`scripts/`、README 与两个声明文件；
`tmp/`、`node_modules/` 不会进包。发布后用户在 Magpie 里安装包名即可。

## 目录

```
page/
  index.html        页面壳
  style.css         设计系统、布局、深浅色
  app.js            渲染、交互、散点/热力图/弹窗
  data-aa.js        模型快照（生成）
  data-harness.js   Agent 快照（生成）
  icon.svg
scripts/
  sync.mjs          同时刷新
  sync-aa.mjs       抓 AA 排行榜页面里的 Next.js flight 数据
  sync-harness.mjs  抓 Harness Leaderboard 的 /api/index
  lib.mjs           fetch、flight 解码、JSON 提取、写模块
test/
  data.test.mjs
  transform.test.mjs
```

## 已知边界

- 上游页面是 Next.js 流式页面，`sync` 依赖 `initialModels` 字段名；AA 改版时需要更新
  `scripts/sync-aa.mjs`。
- Harness Leaderboard 是 HF Space，`/api/index` 的字段与 effort 结构可能变化；
  `scripts/sync-harness.mjs` 的容错只覆盖字段缺失，不覆盖语义变化。
- 价格为公开列表价，不包含账号折扣、缓存、批处理或区域差异。
- 本插件不是两个榜单的官方产品，商标与数据解释权归原站点所有。详见
  `THIRD-PARTY-NOTICES.md`。
