# 价格 (Magpie Models Price)

一个 Magpie 页面插件，读取 Magpie 返回的模型与官方公价（来源为 [models.dev](https://models.dev)）以及本地账单/用量系统（`usage.jsonl`），按模型自动聚合展示所有渠道价格，支持自定义设价、已启用筛选、多维排序与真实 API 花费口径切换。页面模型清单由插件在**本机运行时**生成到 `page/models-data.js`（读取 Magpie 的 `providers-state.json` 与 models.dev 公共目录），该文件不随 npm 包发布；`magpie.read("providers:list")` 只用于合并供应商名称与启用状态。

![价格界面](docs/images/screenshot.png)

## 功能特性

- **按模型聚合展示**：同一原生模型（如 `gemini-3.8-flash`）自动归并为一张卡片，直观呈现所支持的所有供应商重叠图标与渠道列表。
- **真实用量与 Token 统计**：Magpie 窗口内通过宿主 `usage:day`（全量历史）与 `usage:summary`（today/7d/30d）读取，独立 Web UI 直连本地 `/api/usage`；总调用次数、Token 消耗与模型用量徽标在打开、聚焦和每 30 秒自动刷新，不再停在构建时的静态快照。
- **已启用筛选**：一键过滤出当前已启用的活跃模型与渠道，停用渠道一目了然。
- **渠道类型筛选（付费 API / 账号登录）**：按 providers-state 的 `billingKind=payg` 与 `key.set` 判定「付费 API」，其余 plan/subscription 归为账号登录；筛选作用到组内渠道，不再让订阅渠道混进 API 结果。
- **多维度排序**：智能排序（在用的优先：已启用且有调用 → 有调用 → 已启用 → 有价 → 其他；同档按 Token 消耗降序）、按调用次数、按 Token 消耗、按价格（由低到高 / 由高到低）、按渠道数量、按名称（A-Z）。价格排序一律用闲时基础价，不会因为当前是高峰时段而跳动。
- **模型后缀智能归类**：同一渠道里的 `-max` / `-auto` / `-official` / `-highspeed` / 日期快照（`-0731`、`-261017`）/ `-antidowngrade` 等变体会归到同一族合成一张卡，条件是「去掉后缀后的基础模型在同渠道确实存在且价格一致」——`qwen4` 与 `qwen4-max` 这种同名不同价的两份价目不会被误并。组的用量按同族所有变体累加，不再只取一个键。
- **分时峰谷计价（模型级设置）**：models.dev 列的就是原价（闲时价），高峰价 = 原价 × 该模型设置的倍率。**官方价目表里真正分时定价的是 DeepSeek 系模型**——DeepSeek 官方、Command Code、Ollama Cloud，以及阿里百炼 / 火山方舟 / 腾讯 TokenHub 等转售的 DeepSeek，默认工作日 09:00-12:00 与 14:00-18:00（Ollama Cloud 例外，为 12:00-18:00 UTC），倍率 ×2；其他模型全天同价，但也可以在弹窗里单独开启并自定义时段与倍率。每个模型的峰谷配置（启用、倍率、时段）都在「修改定价」弹窗内编辑，首页不再有峰谷卡片。保存时会写入插件 options 的 `modelPeaks`，并汇总同步到 Magpie `providers.json` 的渠道 `rateWindows`（Magpie 只支持渠道级时段，同一渠道的模型需配置一致；冲突时保持原样并报告）。
- **口径提醒（填的是峰价还是谷价）**：编辑弹窗顶部有常驻横幅，输入框标签后面有「闲时价 / 高峰价 / 全天同价」角标，随「上面填的是」分段控件实时切换。填高峰价时横幅会把「保存时 ÷2 换成闲时价、高峰时段 Magpie 再 ×2」讲清楚——填错口径不会报错，只会让 Magpie 按半价或双倍计费，事后极难发现。峰谷卡片底部另外提示「当前哪些渠道真的按小时计费」，一个都没有时直接说明开关只影响本页价签。
- **保存后自查价格是否生效**：独立 Web UI 里保存后页面会调 `GET /api/verify`，把插件里的自定义价与 `settings.json` 的 `modelPrices` 逐键逐字段比对，提示里给出「已核对 N 条全部一致」或「⚠️ 未生效：某键在 Magpie 计费表里是 $x/$y」。Magpie 窗口内的插件页没有这条通道（页面 CSP 是 `connect-src 'none'`），提示只说「已提交」，不会谎称已验证。
- **历史用量的金额会跟着变**：`usage.jsonl` 与 `~/.cache/magpie/calls-v15` 只存 Token，不存金额；Magpie 每次读用量都按当前 `modelPrices`（及高峰倍率）现算。所以改价后历史账单金额立即按新价重算，没有「历史数据需要单独刷新」这回事。
- **峰谷按模型设置**：每个模型在定价弹窗里有独立的「该模型参与峰谷分时计价」开关、倍率输入（0.001–1000）、最多 8 条时段（星期 / 起止，结束早于开始表示跨零点，本机时钟）。默认按官方价目表：DeepSeek 系开启 ×2，其他模型关闭；模型卡片标题旁的「峰谷 ×倍率」角标可快速开关。配置存进插件 options 的 `modelPeaks`（`{"deepseek-v4-pro": {enabled, rate, windows}}`）。写进 `settings.json` 的始终是闲时价，高峰时段由 Magpie 按渠道 `rateWindows` 的倍率计费。
- **账单统计口径切换**：
  - **只记录真实 API 花费**：包月、订阅与免费额度渠道（如 Trae, WorkBuddy, Antigravity）免计费（$0.00），精准记录掏现金的 API 支出；切换后立即落盘，**历史用量会一起按 $0 重算**（Magpie 不存每行成本，按当前价计费）；
  - **显示所有渠道等值公价**：将所有模型消耗按市场公价换算等值市值，清晰掌握各渠道抵扣价值。
- **公价自动匹配**：自动比对识别未定价模型，提供原厂官方公价参考并支持一键全量应用。
- **灵活自定义定价**：
  - 支持指定特定渠道独立调价（如 `antigravity/claude-sonnet-4-6`）；
  - 支持全网通配调价（如 `*/claude-sonnet-4-6`）。
- **原子写入与账单联动**：设定以临时文件 + rename 原子写入 `settings.json`，只合并 `modelPrices` 键，不覆盖其他设置，也不会让 Magpie 读到半截文件；用量看板、会话统计与托盘花费在同一份价格上重算（保存即落盘）。
- **只在保存时写，且只写一次**：插件加载只生成本机页面数据文件 `page/models-data.js`（运行时产物，不提交、不打进 npm 包），不写任何 Magpie 配置，也没有后台定时器；只有页面里的一次保存会写 `settings.json`。保存以 `applyToken` 标记，插件在「保存引起的插件重载」里应用一次，之后的重载（Magpie 启动、开关插件）一律跳过。没有 token 的选项（旧版遗留、手改 `plugins.json`）按「什么都不改」处理，绝不回落到某个默认模式覆盖用户已选口径。
- **流式响应式布局**：完美适配窄屏与侧边栏极窄窗口，控件与内容流式自适应排版。

## 配置目录与本地服务

插件读写的就是 Magpie 自己那份配置，口径与宿主 `internal/appdir` 一致：

| 用途 | 位置 |
| --- | --- |
| 价格、插件 options | `$XDG_CONFIG_HOME/magpie/`，未设置时 `~/.config/magpie/` |
| models.dev 缓存 | `$XDG_CACHE_HOME/magpie/`，未设置时 `~/.cache/magpie/` |
| 主目录 | `HOME`；Windows 上为 `USERPROFILE` |

`XDG_*` 只有写成绝对路径才生效（与宿主的 `rooted()` 判断一致），相对值会被忽略并回落到主目录。首次运行时 `~/.config/magpie` 尚不存在也会自动创建。

插件本身**不启动任何 HTTP 服务**：Magpie 窗口内的页面通过宿主 bridge（`magpie.read` / `magpie.options`）读写，保存由插件在重载时落盘。

独立 Web UI 需要手动运行 `node index.js ui`，默认只监听 `127.0.0.1:3456`，可用 `PORT` / `HOST` 覆盖。它会改写 `settings.json` 与 `providers.json`，所以每个请求都过三道闸：Host 必须是回环名字（防 DNS rebinding）、带 `Origin` 的必须是本地来源、写请求必须是 `application/json`（跨站表单发不出这种类型）。任一不满足直接 403，而不是只省略 CORS 头。

**它会写哪些文件**：只有你按下保存时，才写 `settings.json` 的 `modelPrices` 与 `providers.json` 的 `rateWindows`。保存只写你在页面改动的键：其他已在 `modelPrices` 里的价格原样保留，也不会为你没有的 provider 添加价格。它不会在你没设置的情况下写入任何峰谷时段——首版曾自行给 DeepSeek 渠道写默认时段，现已移除。manifest 只声明 `usage:summary` / `usage:day` / `providers:list` 三个**读**权限，因为写入走的是你显式保存这个动作。

## 开发与测试

```bash
node check.js      # 21 组自测，覆盖目录解析、首次写入、保存只写改动、服务边界与页面 CSP 规范
```

CI 在 ubuntu / macOS / Windows 三平台 × Node 20/22/24 上跑同一套测试，并检查打包产物不含任何本地配置。
## 命令行工具（可选）

页面主要通过图形界面直接操作，同时也支持在终端作为轻量 CLI 脚本运行：

```bash
# 查看所有模型匹配与定价状态
node index.js list

# 切换统计口径为仅记录 API 真实花费
node index.js mode api-only

# 切换统计口径为显示所有渠道等值公价
node index.js mode all

# 一键将所有 models.dev 建议公价写入 Magpie
node index.js sync

# 预览拟同步的设价命令（不实际写入）
node index.js sync --dry-run
```

## 许可证
MIT License © zrtzrt
