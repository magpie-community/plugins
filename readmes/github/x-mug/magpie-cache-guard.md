# magpie-cache-guard

magpie 插件：按「供应商 / 客户端 / 模型」盯住 prompt 缓存命中率，连续偏低时提示；带一个 magpie 窗口内的页面，阈值和状态都在客户端里操作。

命中率口径与 magpie 面板一致：`cache_read / (in + cache_read + cache_write)`。

## 安装

在 Magpie 的 **Plugins → 添加插件** 输入：

```text
github:x-mug/magpie-cache-guard
```

也可在 **Plugins → Discover → Unofficial, on GitHub** 查找 `magpie-cache-guard`（缓存看守）。GitHub 搜索索引和 Magpie 的十分钟列表缓存可能使首次出现延迟。

命令行安装：

```sh
magpie plugin add github:x-mug/magpie-cache-guard
```

固定版本可用 `github:x-mug/magpie-cache-guard#v0.8.7`。配置、阈值与日常刷新均在 Magpie 页面内完成。它只读本机用量账本，不请求模型。

本仓库是缓存看守的源码仓库，根目录就是插件本体。合集 [magpie-plugins](https://github.com/x-mug/magpie-plugins) 用 submodule 把本仓库索引进去，只用于浏览和统一校验，不参与发布。

离线安装可在 [Releases](https://github.com/x-mug/magpie-cache-guard/releases) 下载 `.tgz`，解压到固定目录，再添加解压后的 `package` 文件夹绝对路径。合集仓库 `x-mug/magpie-plugins` 的根目录是工具包，不作为插件安装。

装好后侧边栏 **Plugins** 组里多一个 **缓存看守** 页面；插件本身不提供供应商，没有登录和模型列表，属正常。

文件夹插件是就地加载：已有页面的 HTML/CSS/JS 与图标更新后，刷新或重新打开页面；`index.mjs` 的统计逻辑更新后，在 magpie 插件列表中停用再启用本插件。只有修改页面注册信息（标题、入口等）时才需要重新添加或重启 magpie。

0.6.0 起时间范围的标识从 `live/1d` 换成 `1h/today`：升级后要停用再启用一次本插件，页面才能拿到新数据；旧宿主的数据会让页面提示补齐，不影响已支持的时段。

## 页面里能做什么

页面按 Linear 的设计参考排版：顶部是标题和刷新，紧接着是告警，然后才是数据看板，设置放在最后。

- 顶部工具栏仅保留刷新图标、周期下拉框和最近刷新时间；周期支持 5 / 10 / 30 / 60 秒，修改后直接保存；
- 告警在看板上方：无记录时收为一行，有告警时默认展开；每条记录用实际平均命中率 / 触发阈值、连续低命中次数 / 要求次数、样本最小 Prompt / 过滤下限三项对照，附单次命中率范围与辅助中位数；新记录保存触发时规则，旧记录明确标注缺失字段；
- 时间范围：**1小时 / 今天 / 7天 / 30天**。1 小时是滚动窗口，今天按本机零点起算，其余是账本的滚动窗口；
- 概览和请求明细分为两张独立卡片，中间留出 20px 间距；两张卡片各有一组时间范围按钮，点击任意一处会同步选中状态并更新概览与明细，键盘方向键也同步且保留在原控件内；概览包含缓存命中率、缓存读取、缓存写入、Prompt 总量、平均 token 速度，状态按已保存的命中率阈值显示；
- 概览采用 Linear 参考的 24px 内边距与区块间距，标签、数值、说明之间统一留 8px，不再拼接内部横竖分隔线；宽屏五列、中等窗口三列、小窗口两列，说明文字可自然换行；手机内边距缩为 16px，保留已有浅色主题；
- 明细表顺序为客户端、供应商、模型、请求数、命中率、平均速度、缓存读取、缓存写入，支持搜索；列宽按四个时段全部行的最长内容测量，卡片更宽时余量按各列宽度比例均摊，不会把某一列拉出大片空白；切换时段、搜索保持列宽稳定，字体加载、窗口缩放和数据更新后重测；模型名最多按 32 个等宽字符分配，超长名称省略后可悬停查看，窄窗口只在表内横向滚动；
- 客户端使用本地图标和名称，未知客户端使用通用图标并保留原始名称；窄窗口只在表内横向滚动；
- 看板与告警用同一套请求过滤：`minPrompt` 以下的请求和 `ignore` 前缀的组不参与统计；样本少于 `minRequests` 次的组不列出，表尾说明隐藏数量；
- 监控设置放在最下方，按告警规则、数据过滤和通知分区；可展开修改，保存失败会保留输入并提示；
- 设置通过按钮点击或输入框内回车保存，经 `magpie.options.set()` 写入，保留未在页面展示的已有选项，宿主在下一刷新周期采用；输入不合法时在保存按钮旁说明原因并定位到对应字段。

## 速度与写入口径

平均速度采用已核对的 magpie 0.1.1989 用量页计时规则：`Σ可测输出 token × 1000 / Σ可测生成毫秒`。有推理且记录首正文时，用 `out - reasoning` 和 `ms - first_text_ms`；没有首正文时，仅在可见推理与流持续时间证据充分时，用全部输出和从 `first_reasoning_ms` 起的时长；隐藏推理没有首正文证据时不测速。无推理时使用 `out` 与 `ms - ttft_ms`。

计时剔除错误回复、过短窗口、异常速度和集中回传；`flow_ms` 用于判断回传是否集中，不直接作为速度分母。没有有效计时时显示 `—`，悬停可看有效计时样本数、覆盖率和口径说明；整数取整与宿主一致。0.7.0 前的简单公式已废止，升级需停用再启用本插件，旧后端速度会隐藏并提示更新。

算法一致仍需要相同筛选才能对照数值：本页按客户端 / 供应商 / 原始模型分组，并应用最小 Prompt 和忽略前缀；宿主用量页可选客户端、模型、供应商等筛选，还可能读入会话文件及显示速度下限。本插件只读网关账本，未将会话速度下限混入实测平均速度。

缓存写入只展示账本观测值。magpie 会把 `cache_write` 规范化为数值零；本窗口没有正数写入记录时显示「未观测」或 `—`，无法仅靠账本区分上游未上报与真实零写入。有正数记录时展示累计写入量。

## 告警去哪

- magpie 提示（`notify: "toast"`）；
- 加 `"os"` 时再弹一条 Windows 通知；
- 日志：`plugin warn: cache-guard …`；
- 历史：`~/.config/magpie/cache-guard/alerts.jsonl`。

告警示例：

```
codex/dsh/gpt-6.1-sol 缓存命中偏低：最近 5 次平均命中 8.8%（阈值 80.0%），
连续低于阈值 5/5 次，读中位 3968，prompt 中位 47388
```

## 阈值说明

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `threshold` | `0.8` | 命中率低于它算一次偏低（页面按百分比填，内部存小数） |
| `consecutive` | `5` | 连续多少次才告警 |
| `minPrompt` | `15000` | 小于它的请求不参与统计和告警（分类器、标题这类） |
| `minRequests` | `10` | 看板里样本少于这个次数的组不列出 |
| `pollSec` | `10` | 自动刷新周期：宿主每 N 秒重读一次账本，只影响刷新频率，不改变各时段的起点 |
| `cooldownSec` | `1800` | 同一组两次告警的最小间隔 |
| `maxAlertsPerHour` | `6` | 每小时告警上限 |
| `notify` | `"toast"` | `toast` / `os` / `log` |
| `ignore` | `[]` | 按 `provider/agent/` 前缀跳过 |

## 先验规则（不用装也能看）

```sh
node scripts/check-ledger.mjs
```

用当前账本回放，列出每组会触发多少次告警。实测：DSH 的 cursor/codex 组会命中，zed、Codex CLI、Claude Code 组不告警。

## 开发与发版

需要 Node.js 24，核心校验不依赖第三方库：

```sh
node tools/verify.mjs
```

页面校验用本机 Chrome / Edge 跑无头回归，不读用户账本：

```sh
node verification/run-browser.mjs --browser /path/to/chrome
```

打包并校验内容，顺带生成 `dist/SHA256SUMS.txt`：

```sh
mkdir -p dist && npm pack --ignore-scripts --pack-destination dist && node tools/check-packages.mjs
```

`main` 推送后 CI 跑 Linux / Windows 校验与打包，Windows 另跑浏览器回归；通过后 `Publish release` 按 `package.json` 的版本打 `v<版本>` tag 并发 Release。版本号三处必须一致：`package.json` 的 `version`、`page/index.html` 的 `data-build` 与 `#build` 徽章。同版本 tag 已存在时发版跳过，重跑安全。

## 注意

- 监视器跑在 magpie 的插件宿主里，宿主在第一次有请求时启动；页面状态按已保存的刷新周期写入。
- 插件只读用量账本，不发模型请求；页面只保存本插件选项，宿主写入页面状态与告警记录。卸载时直接在 magpie 中移除。
