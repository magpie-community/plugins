# 上下文透视 (Magpie Context Lens)

[![GitHub](https://img.shields.io/badge/GitHub-zrtzrt%2Fmagpie--context-blue?logo=github)](https://github.com/zrtzrt/magpie-context)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

专为 [Magpie](https://github.com/yetone/magpie) 设计的**跨 Agent 会话内容透视与上下文演进监控页面插件**（对标并超越 `dsh-context`）。纯页面插件，不含网关中间件，也不申请供应商列表权限。

实时监控各 AI 客户端在交互过程中的上下文增长轨迹、Token 构成（System / Tools / Messages / Tool Outputs）、历史压缩事件（Compaction `✂`）与单轮完整内容透视。

---

## 🌟 核心功能特性

### 1. 📈 上下文演进与增长曲线 (Context Evolution Chart)
* **分层 Token 构成堆叠面积图**：
  * 🟣 **System Prompt**：系统提示词、身份与指引基数；
  * 🔵 **Tools Definition**：声明的工具 Schema 与参数定义；
  * 🟢 **Chat History**：多轮对话上下文历史；
  * 🟠 **Tool Results & Files**：工具执行返回值、文件内容与终端输出（上下文膨胀核心源头）。
* **事件时间轴打标**：
  * ✂ **Compaction 压缩标记**：检测上下文突降事件，直观掌握历史截断与压缩时机；
  * ⚡ **Bloat 膨胀预警**：单轮 Token 激增（>15k）自动标记，定位超大文件注入。

### 2. 🔍 逐轮具体内容与消息透视 (Turn-by-turn Content Inspector)
* **逐轮下钻**：点击演进曲线任意轮次（Turn #N），右侧联动展开该轮发给模型的完整 Context 消息树；
* **角色与类型筛选**：支持按 `System`、`User`、`Assistant`、`Tools` 快速筛选；
* **细粒度消耗标尺**：每条消息独立展示 Token 数量、字符数及占当前轮次比例；
* **一键复制与展开**：长文本/工具结果默认折叠保护性能，支持一键展开查看原文与复制到剪贴板。

### 3. 🩺 上下文健康度与体检大盘 (Diagnostics & Headroom)
* **Top 上下文消耗源排行**：快速找出在哪个轮次调用了哪个工具注入了最多的 Token；
* **水位预警 (Watermark Gauge)**：对标模型物理上限（如 Gemini 1M / DeepSeek 128k / Claude 200k），实时提示剩余空间安全边际；
* **优化建议**：智能评估历史压缩效率，预警冗余工具调用。

### 4. 🌐 支持的 Agent 与数据来源
`magpie-context` 直接读取本机各客户端的真实会话日志，无需改动客户端。当前**可完整解析并透视上下文演进**的 Agent 共三类：

| Agent | 会话来源 | 解析方式 |
|---|---|---|
| ✅ **DeepSeek Harness (DSH)** | `~/.dsh` 下的 `.v4.jsonl.zstd` 事件流 | 原生 zstd 解压，按 `request` 逐次折叠出真实上下文构成 |
| ✅ **Google DeepMind Antigravity**（IDE & CLI） | `~/.gemini/antigravity/brain/` 会话目录 | 解析 `usage.jsonl` + 会话 transcript，逐轮还原消息树 |
| ✅ **OpenAI Codex** | Codex 本地会话日志 | 解析 `token_usage_record`，逐步记录真实 token 用量 |

> **说明**：`claude` / `opencode` / `cursor` / `cline` 等来源名称目前**尚未接入会话日志解析器**，因此不会生成可下钻的上下文演进数据。上表三类是真正产出完整透视数据的范围。
>
> 三类 Agent 的每一步 7 类 Token 构成均按该步真实上下文计算（轮内逐步增长，非整轮共用快照），并以该步真实 prompt 为总量归一，堆叠柱与「实际 Token」始终对齐。

#### 跨平台支持

macOS / Linux / Windows 均可运行，CI 在三个平台 × Node 22/24 上验证。Windows 上需要注意两点，都已自动处理：

- **主目录**：Windows 没有 `HOME` 环境变量。插件按 `HOME` → `USERPROFILE` → `os.homedir()` 依次解析；如果三者都不可用，`sync` 会**拒绝写入**并报错退出，不会用一份空索引覆盖你已有的数据。
- **解压**：DSH 的会话是 zstd 压缩的。插件用 Node 内置的 `zlib.zstdDecompressSync`（Node ≥ 22.15）直接解压，**不依赖 `zstd` / `grep` 命令行工具**。

`magpie-context doctor` 会打印它实际解析到的主目录和每个数据源的存在性，排查"为什么没有数据"时先跑它。

---

## 📦 安装方式

```bash
# 从 npm 安装（推荐）
magpie plugin add magpie-context

# 或从源码 / GitHub
magpie plugin add /path/to/magpie-context
magpie plugin add github:zrtzrt/magpie-context
```

安装后页面里会显示「还没有本地数据」的引导，跑一次同步命令即可：

```bash
npx magpie-context sync     # 生成索引，重开页面就能看到数据
npx magpie-context watch    # 可选：每 5 秒增量同步，保持实时
npx magpie-context doctor   # 可选：检查数据源与输出是否就绪
```

> `npx` 会在临时目录里执行命令，而 Magpie 加载的是 `~/.config/magpie/plugins` 里那份。
> CLI 会自动把数据写进 **Magpie 实际加载的那份插件目录**（`magpie-context doctor` 会打印它选了哪个、为什么），
> 所以不会出现「跑了命令但页面还是空的」。要指定别处就设 `MAGPIE_CONTEXT_PAGE_DIR`。

> **为什么安装后还要跑一条命令？**
> Magpie 的页面插件跑在 `sandbox="allow-scripts"` 的沙盒里，CSP 是 `connect-src 'none'`：
> 页面既读不了磁盘，也发不出任何请求（连同源 `fetch` 都被拦），而**只有页面的插件不会启动插件宿主**，
> 所以没有后台进程能替它生成数据。数据只能由你在本机跑命令写入插件目录，页面再用自己的 `<script src>` 加载。
> 这与 `magpie-models-price` 等页面插件是同一套做法。

---

## 🛠️ 本地调试

```bash
cd magpie-context
node bin/magpie-context.mjs watch   # 等价于 npm run watch
```

进入 Magpie 桌面客户端或 Web 控制台，在左侧导航点击 **「上下文」** 即可体验。

---

## ⚙️ 数据加载架构 (v2)

针对大历史库（数十个会话、单会话事件上万条）做了 **索引 + 懒加载** 重构，首屏不再解析上百 MB 内联数据：

| 产物 | 内容 | 体积(本机 65 会话实测) |
| --- | --- | --- |
| `page/context-data.js` | 轻量索引：`CONTEXT_SUMMARY` + `CONTEXT_SESSIONS`(白名单字段) + `CONTEXT_DETAIL_FILES` 映射 | **42 KB**（旧版全量内联单文件 122 MB） |
| `page/data/<safe>.js` | 每会话完整详情（`window.CONTEXT_SESSION_DETAIL[id]`），点击会话时才注入 | 生成物，已 gitignore |

* **首屏骨架屏**：`index.html` 内静态骨架先绘制，索引到达后真实内容原地出现，骨架作为覆盖层 180ms 淡出（Magpie 会话大厅风格虹彩 shimmer，尊重 `prefers-reduced-motion`）。
* **弹窗骨架屏**：点击会话立即打开弹窗并展示四块占位（统计 / 双环图 / 趋势 / 浏览器），详情到达后渲染。
* **详情加载单一合规路径**：`<script src>` 注入 → 失败即弹窗内错误态 + 重试，绝不白屏；会话行 `pointerenter` 预取（并发 3）。
  > 不能用 `fetch`：Magpie 页面沙盒的 CSP 是 `connect-src 'none'`，同源 fetch 一样被拦，内联脚本同样被禁 —— 只有「自己的脚本文件」这一条路。
* **确定性数据**：`callId` 等一律用内容哈希生成（不使用 `Date.now()` / `Math.random()`），同一输入多次 sync 产物逐字节一致；未变化的详情文件不重写。
* **原子落盘**：索引与详情均先写 `.tmp` 再 `rename`；每次 sync 清理过期分片。

### DSH 会话的真实数据来源

DSH 会话直接折叠 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 事件流（`turn/start`、`step/start|end`、`assistant/message.data.usage`、`tool/call`、`tool/result`、`tool/ptc-dispatch`、`job/registered|settled`、`compaction/prune` 等），逐项计算轮次 / 步数 / 技能 / 回复 / 上下文事件 / Token / 耗时 / 文件活动 / 命令执行，口径对齐官方 `dsh-context`：

* `dsh-events.mjs` — 事件流折叠（统计、Token、耗时、当前上下文 7 分类、每步浏览器明细）
* `dsh-fileops.mjs` — 文件活动与命令执行聚合（含 PTC `run_code` 内嵌套调用、路径归一、行数增减、失败 / 后台判定）

早期版本里公式化或常量兜底的数字（`stepsCount = turns × 3`、`speed = 179`、`cacheHitRate = 97.39`、mock 命令 / mock 文件列表等）已全部移除。

### 开发与测试

```bash
npm run sync   # 单次生成 page/context-data.js 与 page/data/*
npm run watch  # 每 5s 增量同步（内容未变的会话不会重写）
npm test       # 含真实会话数据真值对照 + 插件规范一致性检查
```


---

## 📐 Magpie 插件规范符合性

对照官方文档 [编写插件 · 窗口里的页面](https://usemagpie.ai/docs/zh/plugins) 逐条实现，并由 `tests/plugin_spec_compliance.test.mjs` 守着：

| 规范要求 | 本插件的实现 |
|---|---|
| `magpie.page` 提供 `title`/`file`/`icon`/`titles` | 已提供，四语言标签（zh / zh-TW / en / ja），图标为包内 `page/icon.svg` |
| 10 秒内调用 `magpie.ready` 否则显示「没有回应」 | 脚本加载即握手，跟随窗口主题（`onTheme`）与 `data-theme` |
| 只能加载 `file` 所在目录内的文件 | 所有资源均为 `page/` 内相对路径，无 CDN、无外链 |
| `connect-src 'none'`：禁 fetch / WebSocket / beacon | 页面**零网络调用**，数据全部走 `<script src>` |
| 脚本必须是文件，不能内联 | `index.html` 只有 `<script src>`，无内联脚本、无内联事件处理器 |
| `permissions` 只声明真正用到的读取 | **不声明任何权限** —— 本插件不读用量/供应商，只读本地生成的索引文件 |
| 页面拿不到磁盘，数据需预先产出 | `npx magpie-context sync` 生成索引；无数据时显示明确引导，而非「加载失败」 |
| 不把机密数据发给页面 | 打包时用占位索引替换真实数据，`page/data/` 永不出包（见下） |

### 私有数据保护

`page/context-data.js` 与 `page/data/*.js` 是**本机生成的会话数据**（含会话标题、工作区路径、对话正文）。

- `.gitignore` 排除二者，仓库里没有你的会话；
- `.npmignore` 再排除 `page/data/`（正文分片永不进包）；
- `prepack` 把真实索引备份到 `page/.context-data.local.js` 并写入 583 字节**占位索引**（会话数恒为 0），
  `postpack` 再还原 —— 所以 npm 包里不可能带上你的会话，同时装完插件页面也不会 404。

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
