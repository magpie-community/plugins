# 模型广场

在 Magpie 里浏览 AI 模型的标价、上下文和模态。一个页面插件，完全离线。

## 功能

- **共 614 个模型**，快照日期 2026-11-14，来自 [models.dev](https://models.dev/models.json)。
- **标价**：每百万 token 的输入 / 输出。优先取厂商自己接口的非零价；厂商没有价时取其他接口里出现次数最多的价；都没有就显示「未标价」。
- **人民币**：默认按中国外汇交易中心中间价换算显示，右上角可切回美元原价。换算汇率和日期写在页脚，人民币是估算值，不是厂商报价。
- **筛选与排序**：搜索名称、ID、描述或厂商；按种类和厂商筛选；按最新发布、上下文、名称或榜单分数排序。
- **综合能力榜**：使用 Artificial Analysis Intelligence Index 原始分数，不换算相对推荐分。同型号取已收录评测配置的最高分，详情显示配置名称。配置 `AA_API_KEY` 后从 AA 官方免费 API 同步；未配置时读取 OpenRouter 转发的同名指数，页面注明渠道。未评测不计为零分；日期表示抓取时间。点「查看全部」后，下方只显示上榜模型。旧 Coding Index 已停更，不再使用。
- **前端 / 网页榜**：同步 Design Arena 的 Website（HTML、非 Agent）原始 Elo，经 OpenRouter 转发。只比较网页生成偏好，不表示全部软件工程能力。
- **性价比 · 预算内最强**：每百万总 token 成本按输入:输出 = 3:1 估算，预算内按 AA 综合智能原始分排序。人民币档位为 10 / 30 / 100 元，美元档位为 1 / 5 / 20 美元；未标价或未评测的模型不参加。页面离线计算，不把能力分除以价格。
- **布局与主题**：卡片 / 列表，浅色 / 深色 / 跟随系统。
- **复制**：悬停卡片右上角复制模型名称，详情里可复制模型 ID。
- **离线**：页面没有网络权限，不联网、不读取账号或对话。数据随版本打包。

## 安装

通过 [GitHub 仓库](https://github.com/QAyong/magpie-model-square) 安装，或在终端运行：

```sh
magpie plugin add github:QAyong/magpie-model-square
```

装好后侧边栏出现「模型广场」。在发现页的「非官方插件 · GitHub」分类中也可查找；发现列表可能需要等待索引刷新。

## 数据说明

- 模型事实和厂商价格来自 models.dev（MIT 许可），页脚显示快照日期。
- 人民币价 = 美元价 × 中间价，汇率日期与数值写在页脚；切到美元可以看到 models.dev 的原价。
- 图像、视频模型不编按张或按秒的价格，标价仍是每百万 token 的数值。
- 数据只在发版时更新。价格变动频繁，安装新版本即可拿到新快照。

## 开发

页面源码使用 ES module；发布时通过 Bun 合并为 `page/app.bundle.js` 经典脚本，以兼容 Magpie 页面沙盒。修改页面脚本或数据后需重建并提交产物；GitHub 安装直接使用已提交的文件。

```sh
npm install                    # 开发测试依赖
npm run build                  # 需要 Bun；构建发布页
npm test                       # 含受限环境启动回归
node scripts/sync.mjs            # 刷新模型、价格和人民币汇率
node scripts/sync.mjs --rate     # 只刷汇率
node scripts/sync.mjs --dry-run  # 只打印变化，不写文件
node scripts/sync-rankings.mjs    # 刷新综合能力榜；无 Key 时用 OpenRouter 转发
# 配置 AA_API_KEY 后优先使用官方 /api/v2/language/models/free
node --test scripts/aa-rankings.test.mjs # 同步、匹配、原始分和分页
node --test page/view.test.mjs   # 筛选、排序、价格和榜单格式
```

| 路径 | 内容 |
| --- | --- |
| `page/index.html` | 页面结构 |
| `page/app.js` | 卡片、复制按钮、筛选交互、布局和主题 |
| `page/view.js` | 筛选、排序、价格和上下文字符串 |
| `page/catalog.js` | 模型快照和 `category` |
| `page/prices.js` | 每百万 token 标价 |
| `page/currency.js` | 人民币汇率中间价 |
| `page/rankings.js` | 任务榜单快照；没有或为空时页首推荐区隐藏 |
| `page/view.test.mjs` | 筛选、格式和榜单测试 |
| `scripts/sync.mjs` | 抓取 models.dev 与中间价，重写模型、价格和汇率 |
| `scripts/sync-rankings.mjs` | 同步 AA 综合智能榜；Key 仅在同步环境使用 |
| `scripts/aa-rankings.mjs` | 官方分页、转发解析、型号匹配与原始分排序 |
| `AGENTS.md` | 给后续会话的约定和红线 |

页面在 Magpie 的沙盒里运行：没有网络，`localStorage` 不可用，布局 / 主题 / 币种存在 `magpie.options` 里。

## 许可

MIT，见 [LICENSE](LICENSE)。打包的第三方数据与汇率来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
