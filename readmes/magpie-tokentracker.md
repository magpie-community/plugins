# magpie-tokentracker

[![npm version](https://img.shields.io/npm/v/magpie-tokentracker)](https://www.npmjs.com/package/magpie-tokentracker)
[![License: MIT](https://img.shields.io/github/license/jerryjiao/magpie-tokentracker)](./LICENSE)
[![node](https://img.shields.io/node/v/magpie-tokentracker)](https://www.npmjs.com/package/magpie-tokentracker)

在 magpie 窗口里看本机 [TokenTracker](https://github.com/xiufengsun/TokenTracker) 追踪的 AI 用量：今天 / 7 天 / 30 天的总 token、花费、缓存读取、会话数，按编程工具和模型拆分，带小时级与每日趋势；另有订阅配额、近一年活动热力图、成就徽章，以及官方账号 / 云同步入口。全部数据来自本机回环接口，零依赖、不上传。

## 安装

已发布到 npm：

```sh
magpie plugin add magpie-tokentracker
```

装完重启 magpie（桌面 app 只在启动时索引插件库）：侧栏 Plugins 组里出现「TokenTracker」页。验证：app.log 里出现 `plugin: [magpie-tokentracker] board on http://127.0.0.1:<port>/`。

- 升级：`magpie plugin update`（把所有插件装到最新版）。升级后页面还是旧版就重启 magpie。
- 卸载：`magpie plugin rm magpie-tokentracker`。
- 环境：node >= 20、magpie >= 0.1.1340。

## 看板内容

- **指标卡**：总 Token（附输入 / 输出）、花费（附均摊到会话）、缓存读取（附命中率与缓存写入）、会话数。
- **周期**：今天 / 7 天 / 30 天。今天看每小时趋势，7 天和 30 天看每日趋势；柱图带纵轴刻度，横轴最多 10 个刻度。
- **拆分**：按编程工具（source）和按模型（Top 10）排行。
- **订阅配额**：按 provider 列出各用量窗口的百分比与重置时间；<70% 绿、70–85% 橙、>85% 红。
- **近一年活跃**：365 天热力图，附活跃天数与连续天数。
- **成就**：各成就的 tier 与进度（已满级单独标注）。
- **云同步**：右上「云同步」按钮在头部下方展开面板，显示官方账号登录态与入口（详见下文）。
- **主题与语言**：浅色为默认；magpie 深色模式下自动切深色。中文 / 英文跟随 magpie，也可用 `?theme=dark|light`、`?lang=zh|en` 指定。
- **刷新**：20 秒自动刷新主用量，页面隐藏时暂停、切回来立刻拉一次；右上「刷新」和 ⟳ 都会强制拉全部数据。
- **降级**：配额 / 热力图 / 成就任一接口失败只把该面板显示成「暂不可用」，不影响主用量区；TokenTracker 整体不可达时显示离线面板（命令、地址、原因、重试）。

## 结构

```
index.mjs            magpie 宿主入口：server(input, options)，懒启动本机服务
server.mjs           零依赖 node:http 服务（只绑 127.0.0.1），拼全内联看板页并暴露 /api/*
lib/usage.mjs        纯函数：周期换算、卡片/拆分/序列整理、配额/热力图/成就整理
lib/tokentracker.mjs TokenTracker 探活、自动拉起、回环接口调用
lib/official.mjs     官方账号登录态：读本机 config.json，返回掩码后的 ID
page/index.html      magpie 托管的带路页（bridge 握手 → 导航到本机服务）
page/boot.js         读语言/主题/端口；magpie web 转发模式下先探活，失败给重试
page/board.html      看板模板（服务端把 style/app 内联进来）
page/app.js          看板逻辑（渲染、周期、自动刷新、各面板降级）
page/style.css       看板样式（浅色/深色两套变量）
page/icon.svg        插件页图标
test/*.test.mjs      31 个测试（node --test）
test/fixtures/       从真实 TokenTracker 接口抓的样例
docs/                设计规范、发布手册（不进 npm 包）
```

## 依赖

本机要有 TokenTracker 在 `127.0.0.1:7680`（官方 CLI 的 `serve`）。没有也没关系：服务第一次被问到用量时会自动拉起（见下面的选项），拉不起来时页面显示离线提示和命令。

```sh
npx tokentracker serve        # 或 tokentracker serve
```

实测版本：TokenTracker 1.5.22。配额 / 热力图 / 成就三个面板读的是较新的本机接口，老版本没有对应接口时这三个面板显示「暂不可用」，主用量不受影响。

## 选项（magpie → Plugins → TokenTracker 的 options）

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `port` | `MAGPIE_TOKENTRACKER_PORT` | `3491` | 看板服务的端口（`0` = 随机，测试用） |
| `tokentrackerPort` | `MAGPIE_TOKENTRACKER_TT_PORT` | `7680` | TokenTracker 的端口 |
| `autoStart` | `MAGPIE_TOKENTRACKER_AUTOSTART` | `true` | 探活失败时自动 `spawn` TokenTracker |
| `command` | `MAGPIE_TOKENTRACKER_COMMAND` | `""` | 拉起用的命令；空 = PATH 里的 `tokentracker`，再退到 `npx -y tokentracker-cli` |
| `timeZone` | `MAGPIE_TOKENTRACKER_TZ` | `""` | 「今天」的时区；空 = `Asia/Shanghai` |

环境变量在手动跑服务时方便，同名选项优先。

## 服务接口（全部只读，只对 127.0.0.1 开）

| 路由 | 说明 |
|---|---|
| `GET /`、`/index.html` | 看板 HTML（全内联单页；CSP `unsafe-inline` + 显式回环 connect-src，见「注意」） |
| `GET /app.js`、`/style.css`、`/icon.svg`、`/favicon.ico` | 原始静态文件（调试用，看板本身不引用） |
| `GET /api/usage?period=today\|7d\|30d[&force=1]` | 主用量 JSON：卡片、按工具、按模型、小时/日序列 |
| `GET /api/limits[?force=1]` | 订阅配额：各 provider 的用量窗口百分比与重置时间 |
| `GET /api/heatmap[?force=1]` | 近一年热力图：365 天格子、活跃天数、连续天数、月份标签 |
| `GET /api/achievements[?force=1]` | 成就：tier 与进度 |
| `GET /api/cloud` | 官方账号登录态（ID 掩码）+ 官方链接 + 登录命令 |
| `GET /api/status` | 本服务端口 + TokenTracker 探活结果与版本 |
| `GET /api/healthz[?probe=]` | 存活检查；带 `probe` 时回一段合法 JS，供带路页跨源探测 |

- 缓存：主用量 8 秒，配额 60 秒，热力图 / 成就 5 分钟；`force=1` 跳过，同周期并发请求合并。`/api/cloud` 只读本机配置文件，不缓存。
- TokenTracker 不在时数据接口回 503，payload 里带 `hint.command`；自动拉起失败后有 60 秒冷却，避免每 20 秒的自动刷新反复 spawn。
- magpie 的页面 frame 是 opaque origin（`Origin: null`），所以 `/api/*` 对它回 `Access-Control-Allow-Origin: null`；其它 Origin 一律 403。数据本身不是秘密（TokenTracker 自己的读接口就是回环裸奔的），不加鉴权。
- 拉起的 TokenTracker 用独立进程组（`detached: true`），服务退出时整组 SIGTERM，不留孤儿占着 7680。

## TokenTracker 接口约定（实测 1.5.22）

本机接口挂在 `/functions/<slug>` 下：

- `GET /api/local-auth` → 探活 + `serverVersion`。
- `tokentracker-usage-summary?from&to&tz&rolling=1`：总量、花费、缓存、会话、`rolling.last_7d/last_30d`。
- `tokentracker-usage-daily` / `tokentracker-usage-hourly`：日/小时序列。
- `tokentracker-usage-model-breakdown`：按工具（source）→ 模型的拆分和定价。
- `tokentracker-usage-limits`：订阅配额窗口。
- `tokentracker-usage-heatmap?from&to`：每日活跃。
- `tokentracker-achievements`：成就与进度。
- 花费不在 `queue.jsonl` 里，是按定价表算的，所以必须走 HTTP 接口，不能直接读文件。
- 官方账号登录态不在接口里，读本机 `~/.tokentracker/tracker/config.json`（`lib/official.mjs`）。

## 官方云同步与排行榜（可选）

看板之外，[TokenTracker](https://github.com/xiufengsun/TokenTracker) 官方还提供两项云上能力：

- **全球排行榜**：登录官方账号即可参加，免费。
- **官方 Cloud 云同步**（付费，[www.tokentracker.cc/cloud](https://www.tokentracker.cc/cloud)）：多设备用量聚合与网页历史。官方标价 $4.99/月，以官方页面为准。

看板右上「云同步」按钮展开面板：未登录时给登录方式（打开本机 TokenTracker 看板的 Settings → Account，或 `tokentracker device-login`）和 Cloud 介绍入口；已登录时显示掩码后的账号 ID。不登录也不影响本地功能——看板的全部本地能力（读取、展示、按工具/模型拆分、趋势、配额、热力图、成就）只走本机回环接口，不需要任何账号。

## 常见问题

### 本机没装 TokenTracker，怎么办？

不用提前装。服务第一次被问到用量时会探活 `127.0.0.1:<tokentrackerPort>`（默认 7680）；失败且 `autoStart` 开着（默认开）就自动拉起：优先 PATH 里的 `tokentracker`，退到 `npx -y tokentracker-cli`，都可以用 `command` 选项自定义。拉不起来时页面显示离线面板（可直接复制的命令 + 地址/原因 + 重试）；拉起失败后有 60 秒冷却，避免自动刷新反复 spawn（细节见「依赖」「选项」「服务接口」三节）。

### 安装后在侧栏找不到「TokenTracker」页，或页面空白？

按顺序查：① 重启 magpie（桌面 app 只在启动时索引插件库）；② `magpie plugin list` 里有没有 `magpie-tokentracker`，版本是不是最新的（升级见「安装」）；③ app.log 里有没有 `plugin: [magpie-tokentracker] board on ...`；④ 直接打开日志里那个 `http://127.0.0.1:<port>/`，能打开说明服务正常，问题在页面下发。本地路径安装的旧坑见下文「本地开发」。

### 没登录官方账号？

本地看板全功能可用——它只读本机 TokenTracker 的回环接口，不需要任何账号。网页历史、全球排行榜、官方 Cloud 云同步（付费）才需要登录官方账号：在官方看板 Settings → Account 里登录，或执行 `tokentracker device-login`。

### 数据上传了什么？

插件看板本身不向任何地方上传数据——它只读本机 TokenTracker 的回环接口。这些接口暴露的也只是聚合用量数字：tokens 数、按定价表估算的费用、模型名、编程工具名、小时/日时间桶，不含任何代码、提示词、对话内容或文件内容（见「TokenTracker 接口约定」）。只有当你主动使用官方 Cloud 云同步（付费）时，数据才会同步到官方云端，内容同样是用量数字，不是代码与对话。

## 本地开发

改代码时不装 npm 包，把项目软链进插件库（本机开发用的就是这种）：

```sh
ln -sfn "$PWD" ~/.config/magpie/plugins/node_modules/magpie-tokentracker
```

重启 magpie 后生效。**本地路径安装的坑（2026-11-17 白屏事故）**：magpie 的页面文件（`magpie.page.file`）只从插件库 `~/.config/magpie/plugins/node_modules/<name>/` 下发；`magpie plugin add <本地路径>` 只注册 spec、执行服务代码，但不拷 page 文件 → 页面 tab 永远白屏（服务其实是活的）。软链就是为绕开这个；正常用户从 npm 装则不存在这个问题（page 文件随包下发）。

### 开发命令

```sh
npm test                      # node --test test/*.test.mjs（29 个）
node index.mjs                # 手动跑服务（默认 3491），Ctrl-C 会带走拉起的 TokenTracker
open http://127.0.0.1:3491/   # 直接看板（浏览器里 localStorage 可用，周期会被记住）
```

改了 `server.mjs` 或 `index.mjs` 要再 `magpie plugin add <路径>` 一次（或重启 magpie），magpie 的 Bun 宿主才会重新加载；只改 `page/` 下的文件不用，看板是每次请求现拼的，刷新页面即可（`server.mjs` 的 `BUILD` 需要 +1 的情况除外，见「注意」）。

发布流程（GitHub release / npm publish / magpie 收录）见 [`docs/publish-checklist.md`](./docs/publish-checklist.md)；界面规范见 [`docs/design-spec.md`](./docs/design-spec.md)。

## 注意

- TokenTracker CLI 第一次 `serve` 会做初始化：给 Claude Code 写 hooks、改 Codex CLI 配置、装 Opencode 插件。都是可逆的，但要知情。
- 端口 3491 是挑过的：magpie 里 loop-guard 插件占了 3477/3478，避开。
- 端口被占时不再硬失败（magpie 自升级交接的真实事故修出来的）：同款服务连续两次探活成功 → 复用；否则每 0.5 秒重试绑定，首次预算 8 秒（必须低于 magpie 插件加载的 20 秒上限，超了它判加载失败且不再重试）。**复用之后会一直守望这个端口**：对方一停应答（它的宿主退出了）就自己绑，日志打 `took over from a service that quit`——不复用就接手，是「带路页卡住不动」那个 bug 的根。`/api/healthz` 带指纹 `{service, build}`（复用按服务名判，不按 build —— 多实例共存的稳定优先；升级代码后想让老 build 退位，`magpie plugin rm magpie-tokentracker && magpie plugin add magpie-tokentracker` 走一遍，宿主整个换进程）。
- 已知边界：同一台机器同时跑桌面 app 和 `magpie web` 时，第二个实例会复用桌面侧的服务（同款指纹），页面照常跳本机服务。
- 看板是全内联单页（服务端把 style.css/app.js 内联进 board.html，并把 `__SERVICE_BASE__` 注入成 `http://127.0.0.1:<port>`）：magpie 的页面 frame 是 `sandbox="allow-scripts"` 的 opaque origin，CSP 里 `'self'` 匹配不到任何来源，外链 css/js 和相对 fetch 全会被拦；所以 CSP 用 `'unsafe-inline'` + 显式回环 connect-src，fetch 一律走绝对地址。
- 同一个沙盒原因，页面里的 `localStorage` 不可用（读周期选择会降级为不记忆，不影响其它功能）；直接浏览器打开时正常记忆。
- 改了 `server.mjs` 记得 `BUILD` +1（healthz 里看得见）；改了 page 文件不用，内联是每次请求现拼的。

## License

[MIT](./LICENSE)
