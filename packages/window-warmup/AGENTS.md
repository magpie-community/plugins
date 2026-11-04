# AGENTS.md

本包是 magpie 社区插件「窗口预热（Window Warmup）」：在 magpie 宿主进程里按计划向指定供应商 / 账号 / 模型发一条 `hi`（`max_tokens: 16`），提前开启订阅额度窗口。源码位于社区仓库 magpie-community/plugins 的 `packages/window-warmup/`，作者 YangHonghang。用户可见行为、触发规则、去重与费用说明以 `README.md` 为准，改行为时同步更新 README。

## 命令

运行时、包管理器、构建与测试都用 Bun（`engines.bun >= 1.4.2`），不引入其他构建工具。

```sh
bun install                                   # 仓库根目录：安装所有 workspace 的依赖（含 playwright）
bun run build        # packages/window-warmup 内：scripts/build.ts → dist/plugin.js、dist/ui/…
bun run typecheck    # packages/window-warmup 内：tsc --noEmit，覆盖 src、scripts、tests、web
bun test             # 仓库根目录：跑所有包的测试；包内跑本包测试
bun test tests/rules.test.ts          # 单个文件
bun test tests/scheduler.test.ts -t "关键字"   # 按用例名过滤
```

- **`dist/` 入库**，宿主直接加载 `dist/plugin.js`（`package.json` 的 `main`），服务从 `dist/ui` 提供静态页。改了 `src/` 或 `web/` 必须 `bun run build` 并一并提交 `dist/`。
- `tests/server.test.ts` 的 `beforeAll` 会调用 `buildAll()` 重建 `dist/`。
- `tests/fake-gateway.ts` 是假的 magpie 网关，网关 / 调度相关测试都靠它，不打真实网关。
- `tests/browser.test.ts` 用真实 Chromium 与 WebKit 走一遍页面冒烟。Playwright 是**可选依赖**：仓库不安装、CI 也不安装，评审机通过 `NODE_PATH` 提供；本机没装时整组自动跳过。要本地跑：自备 playwright（如 `bunx playwright install chromium webkit`），并在真实 HOME 下运行或设 `PLAYWRIGHT_BROWSERS_PATH`。
- `tests/dist.test.ts` 构建到临时目录，与入库的 `dist/` 逐字节比对；测试本身不写工作区，改源码后必须 `bun run build` 并提交 `dist/`。
- `tests/discoverability.test.ts` 校验 `registry.json` 条目、搜索词与包契约，改包名或简介时一起看。

## 发布

- **合并 PR 即发包**：社区仓库的 `.github/workflows/publish.yml` 由 `packages/window-warmup/package.json` 的版本变化触发，先跑全仓测试与 `scripts/check.mjs`，再把新版本打包进 `dist` 分支（magpie 在没有 npm 版本时从那里安装），最后把 npm 上还没有的版本发布出去。
- **版本号必须和改动在同一个 PR**：只改代码不改 `version`，合并后不会发版，用户也拿不到。发新版就加版本号（0.1.1、0.1.2…）。
- 新包在 npm 的第一个版本无法用 Trusted Publishing 创建，需要社区 owner 手动发布一次；在那之前 magpie 从 `dist` 分支安装。`README` 因此不写 `npm i`。
- 已安装用户由 magpie 自动更新（社区包一小时内），无需用户操作。
- 本仓库的 `registry.json` 条目（`kind: "page"`、`community: true`）只在名称、图标或中英文简介变化时才需要改；包名、图标 URL 由 `tests/discoverability.test.ts` 守卫。

## 架构

两层入口 + 一个带路页：

- **`page/index.html` + `page/boot.js`（带路页）**：magpie 页面框架里加载的页面。CSP 为 `connect-src 'none'`，脚本不能联网探测，只能整页跳转到本地服务；跳转时带上 magpie bridge 给的主题、语言、设计令牌，`magpie web` 场景优先跳 `window.magpie.service` 转发地址。
- **`src/plugin.ts`（宿主入口）**：`server()` 先探测端口上是否已有本插件（所有响应带 `x-window-warmup: 1`），有就复用；没有才迁移旧数据并 `startService`。**模块不要导出额外函数**——宿主会把导出的每个函数都当插件函数调用。
- **`src/server.ts`**：只监听 `127.0.0.1` 的 Bun 服务。每进程随机 token 注入首页，`/api/*` 必须带 `x-window-warmup-token`；校验 Host / Origin（防 DNS 重绑定）、CSP。store 损坏 → fatal（只展示原因、不调度、拒绝写）；锁被他人持有 → 只读。
- **`web/app.ts`（页面 UI）**：DOM 一律 `createElement` + `textContent`，不拼 HTML。导出的纯函数供测试复用，被 import 时不碰 DOM（文件尾部守卫）。编辑区由 `buildEditor` 按区块拼装（`sendToParts` / `triggerSeg` / `triggerFields` / `nextPreview` / `editorActions` / `runsSection`）。i18n 在 `web/i18n.ts`（`app.ts` 原样转出，测试从 app 取用），键即中文原文，en / zh-TW / ja 三张表键集合必须一致（`tests/i18n.test.ts` 守卫）。

核心模块分工：

- **`src/rules.ts`**：纯时间计算（每天定时含时区 / 夏令时、固定间隔、窗口到期 = `resetsAt` + 30s、补发回看 48 小时）、任务校验与探活消息常量。**页面直接打包本模块**（编辑区预览与调度器用同一个 `upcoming`），所以它只能依赖 `types.ts`，不得引入 `node:*` 或网关模块（`tests/rules.test.ts` 有守卫）。`types.ts` 同理，另放各层共用的 `errText`。
- **`src/scheduler.ts`**：所有改状态入口（tick / upsert / remove / runNow）走同一操作队列串行；发送本体在队列外但登记在 inflight，保证同任务不重叠、删除后异步完成不会把记录写回。单定时器，最长睡 10 分钟后重算。窗口任务发送前后让 magpie 单卡重读额度（`readAt` 早于上次发送的空闲读数不信）。判断逻辑集中在几个私有函数：`pendingFixedDue`（定时/间隔该不该补发）、`currentWindowDue` + `windowReady`（窗口到期且本轮未尝试，纯计算）；`lastReset` 只在 `recordResets` 里写（额度刷新后与 `rearm` 时），不要再把写盘塞回查询路径。`resolveSend` 的存在性判定是 `/v1/models` ∪ chosen：模型被路由组藏出 `/v1/models` 时靠 chosen 照发，拿不到档位元数据就按「不适用」不带 `reasoning_effort`。
- **`src/gateway.ts`**：与本地 magpie 网关（`MAGPIE_ADDR`，默认 `127.0.0.1:3425`）通信：`/v1/models`、`/v1/magpie/quotas`（含单卡 refresh）、`/v1/chat/completions`；思考档位 `pickEffort` 每次发送前现算。
- **`src/accounts.ts`**：**统一账号规则的唯一实现**——`/api/catalog` 与调度器共用（账号合并、key 卡挂回、按账号收窄模型、`pickAutoModel`）。禁止在别处另写一套，否则页面显示与实际发送会不一致。
- **`src/magpie-files.ts`**：只读 magpie 的 `providers.json` 与模型缓存。`readDefaultKeyDirectory` / `readDefaultModelCache` 是目录与调度器共用的默认读取入口；`xdgConfigHome` 是插件数据目录、旧包迁移与 Magpie 配置目录共用的 XDG 解析（只认绝对路径）。**红线**：key 原文只允许在 `readKeyDirectory` 内「读 → 算指纹（sha256 前 5 字节 hex）」后即丢，不得进入返回值、日志、错误信息或缓存；JSON 解析失败一律换成固定文案 `BROKEN_PROVIDERS_MESSAGE`。除 key 指纹与 `accountModels` 外还取每供应商的 `models`（chosen 启用清单）：模型被路由组 `unlists` 藏出 `/v1/models` 时它是唯一的存在性来源。
- **`src/diagnostics.ts`**：`GET /api/diagnostics` 的诊断导出（页面底部「反馈问题」把它拼进 issue 正文，`web/app.ts` 的 `issueURL` / `issueBody`；插件框架只有 `allow-scripts`，下载、弹窗、Clipboard API 都被拦，复制只能用 `execCommand("copy")`），只读、不发模型请求；在只读拦截之前，fatal / 只读实例也能导出。内容是排错现场：各供应商的原始输入（`/v1/models`、chosen、模型缓存、额度卡）与 `/api/catalog` 计算结果并列，外加任务、最近执行记录、marks 与 `Scheduler.previewSend`（按 `resolveSend` 现算此刻会怎么发）。**红线**：账号名、key 指纹、key 名、任务名、额度卡显示名不得原样出现——账号与 key 统一经 `Aliases` 换成 `acct-N` / `key-N`（全份导出一一对应），自由文本一律过 `scrubber`；新增导出字段时先想清楚它是否可能夹带这些原文。列表与文本有上限（`LIST_MAX` / `RUNS_PER_TASK` / `TEXT_MAX`），截断记入 `truncated`。`tests/diagnostics.test.ts` 逐项断言隐私原文不出现。
- **`src/store.ts`**：`state.json` 临时文件 + rename 落盘，损坏时拒绝启动且绝不改动原文件；`service.lock` 原子排他创建 + pid 活性判断（活性不明不抢占，pid 存活但端口无本插件应答视为陈旧锁接管）；一次性从旧包 `scheduled-messages` 迁移 `state.json`。

## 供应商 → 账号 → 模型级联（无官方接口的绕行路径）

Magpie 不提供「供应商 / 账号 / 每账号可用模型」的列表接口，目录是拼出来的。用户视角的完整说明见 README「供应商 → 账号 → 模型」一节，改规则时两处同步。

**数据链路**：`fetchCatalog`（`src/gateway.ts`）并发读取 `/v1/models` 与额度卡（`fetchQuotas`：平时 `?kept=1` 只读缓存，缓存空时兜底读完整接口，至少间隔 5 分钟），再经 `readDefaultKeyDirectory` / `readDefaultModelCache` 读 `providers.json` 和 `<缓存目录>/models/<pid>.json`，逐个供应商调用 `accountsOf` 生成 `/api/catalog`。页面（`web/app.ts` 的 `accountOptions` / `modelOptions` / `windowOptions` / `accountModelView`）只消费目录、不做推算，每 60 秒刷新。调度器 `resolveSend`（`src/scheduler.ts`）发送前重新读同样的数据，再调用同一组函数（`modelsForAccount`、`pickAutoModel`、`pinFor`、`windowsForAccount`）。

**关键绕行点**（都在 `src/accounts.ts` 与 `src/magpie-files.ts`）：

- **供应商**：模型按 `owned_by`、否则按 id 首段归属（`modelProvider`），跳过 `group/`；额度卡的 provider 也算，`<p>/~keys` 归一为 `<p>` 并标记 `viaKey`（`parseQuotas`）。
- **key 账号**：`providers.json` 的 `key` + 未停用的 `keys[]`，取 `sha256(key)` 前 5 字节 hex 作为指纹，与 Magpie `internal/provider/keys.go` 的 keyID 同一算法。这个指纹是连接三方的唯一桥梁：模型缓存的 `Keys`、`accountModels` 的键、发送头 `<P>#<指纹>`。改算法会让三处同时失配。
- **订阅账号**：非 key 卡的额度卡 `user`。
- **key 账号的窗口**：用指纹反查 key 名，匹配 `<p>/~keys` 卡的 `user`（不分大小写相等，或以 `名字 · ` 开头）；无名 key 接受无窗口。
- **模型三层过滤**（`modelsForAccount`）：
  1. 缓存 `Keys` 可见性（仅缓存存在且账号是指纹时）；
  2. `accountModels[指纹或小写账号名]`，比对不带供应商前缀的 id；
  3. 仍在 `/v1/models` 里，或仍在 chosen 启用清单（`providers.json` 的 `models`）里——后者接住被路由组 `unlists` 藏出 `/v1/models` 的模型。

  候选 = 缓存 ∪ `/v1/models` ∪ chosen（按完整 id 去重）。缓存 id 不一定是对外 id（antigravity 缓存存分档变体 `gemini-3.8-flash-high`，对外只有 `gemini-3.8-flash`），只用缓存会整列表为空；缓存外的候选没有 `Keys`，第 1 层视为所有 key 可见。无缓存时 `perAccount: false`，三者皆无时返回 `list: null`。
- **发送头**（`pinFor`）：订阅账号原样发；key 指纹在启用 key 不少于 2 把（目录读不出时按 2 把处理）时发 `<P>#<指纹>`，只有 1 把时不带头，因为此时候选 ID 就是供应商 id；其余值（旧任务存的 key 名）原样发。非 ASCII 头值按 UTF-8 字节写入（`send`）。
- **文件位置**（`magpieDirs`）：从安装路径 `<配置目录>/plugins/node_modules/@magpie-community/page-window-warmup/dist` 上溯得到配置目录；旧独立包名 `node_modules/magpie-window-warmup/dist` 也识别（升级用户的旧路径）。再据此区分安装版和便携版的缓存目录。`tests/magpie-files.test.ts` 覆盖了新作用域路径、旧路径、Windows 与便携版。

## 约定

- 默认端口 3492 同时出现在 `package.json`（`magpie.options` / `magpie.page.service`）、`src/plugin.ts` 的 `DEFAULT_PORT`、`page/boot.js`，改动需三处一致。
- 插件页的搜索文本来自 `registry.json` 这一条的 `name` + 包名 + 当前语言 `summary`（小写子串匹配、不分词），`tests/discoverability.test.ts` 逐个搜索词守卫；`package.json` 的 `keywords` 只服务 npm 自身搜索。
- 除本地 magpie 网关外不得引入任何对外连接；预热消息内容固定，不提供自定义。
- Commit 格式：`[type] 中文简述`（`feat` / `fix` / `doc` / `refactor` / `test` / `chore`），参见 `git log`。
