<div align="center">

<img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/assets/icon.png" width="96" alt="本地服务">

# 本地服务 · Local Services

**告别满屏终端窗口 —— 在 magpie 里统一托管本地常驻服务，并一键分享到公网供他人使用**

![version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Bun-black?style=flat-square)
![magpie](https://img.shields.io/badge/magpie-page%20plugin-orange?style=flat-square)

[解决什么痛点](#解决什么痛点) · [核心亮点](#核心亮点) · [快速开始](#快速开始) · [场景演示](#场景演示) · [配置与原理](#配置项)

</div>

<p align="center"><img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/01-services-list.png" alt="服务列表" width="820"></p>

## 解决什么痛点

日常开发和使用 AI 工具时，本机往往要常驻一堆后台命令：本地 API 网关、MCP 服务、反向代理、开发服务器、Webhook 接收端……

| 过去的折腾 | 用「本地服务」之后 |
| --- | --- |
| **终端开满屏**：5、6 个不能关的终端窗口占着桌面，手滑关错一个服务就挂 | **零终端统一面板**：全部收进 magpie 侧边栏，一处看清运行状态、端口与实时日志 |
| **启停靠手敲**：每次开机挨个 `cd`、设环境变量、按顺序敲启动命令；停服务还容易残留子进程 | **队列自启 + 干净回收**：随 magpie 按依赖顺序分批拉起；停止时连同子孙进程一并清理 |
| **联调分享难**：想把本地跑起来的服务给同事体验、给手机预览或接外部 Webhook，还得折腾内网穿透和账号配置 | **一键公网分享**：免注册、免配置，几秒生成 `https://*.trycloudflare.com` 公网链接，发给别人点开就能用 |
| **版本靠人盯**：开源工具发了新版不知道，想升级还得切回终端重装重启 | **自动追新升级**：绑定 GitHub 仓库后自动检查 Release，支持一键升级或后台自动更新并重启 |

---

## 核心亮点

- **🖥️ 在 magpie 里一站式掌控** — 状态一目了然，自动识别服务监听端口（点端口标签直接复制 `http://127.0.0.1:端口`），一键直达服务首页，实时查看合并日志，列表支持拖拽排序与撤销删除。
- **🌐 一键把本地服务分享给任何人** — 内置 Cloudflare 免费快速隧道，无需 Cloudflare 账号或域名配置。无论是已托管的服务还是本机任意端口，点一下就能拿到公网 HTTPS 地址，跨设备测试、团队演示、远程联调即开即用。
- **🛡️ magpie 重启也不掉线** — 服务以独立进程组在后台运行，与 magpie 生命周期解耦；即使重启 magpie 或更新插件，也会自动重新接管运行中的服务，日志不断档。停止时先跑自定义终止命令，再按进程组 `SIGTERM → SIGKILL` 兜底，绝不留孤儿进程。
- **🚦 按启动队列有序拉起** — 开启「随 magpie 启动」后，按队列编号（`1–99`）从小到大分批启动，前一批全部就绪并稳定运行 1.5 秒后才拉起下一批，从容应对「先起数据库/代理，再起网关/应用」的依赖顺序。
- **🔔 新版本自动找上门** — 绑定 GitHub 仓库后定时检查最新 Release，自动探测本地版本号。支持后台自动执行更新命令并平滑重启正在运行的服务，也可以手动一键更新或忽略特定版本。

---

## 快速开始

**环境要求**：macOS + [magpie](https://usemagpie.ai) `>= 0.1.1340`（插件由 magpie 内置的 Bun 直接运行，无需额外安装 Node/Bun 依赖）。

**1. 安装插件**

```bash
magpie plugin add github:edifierx666/magpie-local-services
```

**2. 安装公网分享工具（可选，使用「分享到公网」功能时需安装）**

```bash
brew install cloudflared
```

启用插件后，点击 magpie 左侧边栏「插件」分组下的 **本地服务** 即可开始托管。

---

## 场景演示

### 1. 托管常驻服务与查看实时日志

点击「新建」，把原本要在终端里敲的启动命令填进来即可：

| 字段 | 示例 |
| --- | --- |
| 名称 | `my-node-app` |
| 命令 | `node server.js --port 3000` |
| 工作目录 | `~/projects/my-node-app` |
| 环境变量 | `NODE_ENV=production`、`PORT=3000` |
| 首页地址 | `http://127.0.0.1:3000`（可留空） |
| 随 magpie 启动 / 启动队列 | 打开 / `2` |

<img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/02-service-editor.png" alt="新建服务" width="560">

保存并点击「启动」后，行内会自动浮现监听端口 `3000` 与 PID 标签，点击端口即可复制本地地址；右侧外链图标可一键打开服务首页（留空时回退到 GitHub 仓库地址）。切换到「日志」随时查看实时输出，再也不用翻找终端窗口：

<img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/03-logs.png" alt="日志" width="720">

### 2. 一键分享到公网供他人访问

本地服务跑起来后，想让同事直接访问你的接口或页面？在服务的 `⋯` 菜单选择 **「分享到公网…」**，或者切换到 **「隧道」** 标签页填入任意本机端口，点击「开始分享」：

| 分享到公网 | 隧道集中管理 |
| --- | --- |
| <img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/07-tunnel-share.png" alt="分享到公网" width="380"> | <img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/08-tunnels-list.png" alt="隧道列表" width="420"> |

几秒内即可拿到 `https://*.trycloudflare.com` 公网地址，一键复制发给对方即可直接访问；用完随时关闭隧道，干净省心。

### 3. 跟踪 GitHub 版本并自动更新

托管本地开源组件（如 CLI 网关、代理工具等）时，在服务的「更新」区域绑定仓库与升级命令：

| 字段 | 示例 |
| --- | --- |
| GitHub 仓库 | `nodejs/node` |
| 版本命令 | 保持「自动检测」即可，会自动探测如 `node --version` |
| 更新命令 | `brew upgrade node` |

当上游发布新版本时，列表会直接提示「`v… 可用`」，你可以选择「立即更新」「查看发布页」「忽略此版本」或「标记为当前版本」。默认开启「自动更新并重启」：后台巡检发现新版本且配置了更新命令时会自动升级，并在成功后重启原本运行中的服务（已停止的服务不会被意外拉起）。匿名查询额度为 60 次/小时，可在设置中填入无需任何权限的 GitHub Token 提升额度。

<img src="https://raw.githubusercontent.com/edifierx666/magpie-local-services/main/docs/screenshots/04-update-available.png" alt="发现新版本" width="720">

---

## 配置项

<details>
<summary><b>插件选项与环境变量</b></summary>

插件选项可通过 `magpie plugin options magpie-local-services '<json>'` 设置。

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 选项 `port` | number | `3427` | 插件本地面板与 API 的端口（1024–65535） |
| 选项 `token` | string | 首次打开自动生成 | 面板访问令牌（≥32 位） |
| `LOCAL_SERVICES_PORT` | number | — | 覆盖面板端口，优先于选项 `port` |
| `LOCAL_SERVICES_LEADER` | `1` / `0` | 自动判断 | 强制当前插件宿主接管 / 不接管服务（调试用） |
| `GITHUB_TOKEN` / `GH_TOKEN` | string | — | 面板未保存令牌时用于查询 Release；都没有再试 `gh auth token` |

</details>

<details>
<summary><b>面板设置</b></summary>

| 设置 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 自动检查更新 | boolean | `true` | 定时查询已绑定仓库的最新 Release |
| 自动更新并重启 | boolean | `true` | 后台检查发现新版本且有更新命令时执行；成功后重启正在运行的服务 |
| 检查间隔 | number（小时） | `12` | 1–168 |
| GitHub 访问令牌 | string | — | 保存前向 GitHub 验证；只用于查询公开仓库，无需勾选任何权限 |

</details>

<details>
<summary><b>服务字段说明</b></summary>

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 名称 | string | — | 必填 |
| 命令 | string | — | 必填，在登录 shell（`-i -l -c`）中执行 |
| 工作目录 | string | 用户主目录 | 运行目录 |
| 环境变量 | 每行 `KEY=value` | — | 额外环境变量 |
| 终止命令 | string | — | 停止时先执行（最多等 30 秒），可用 `$LOCAL_SERVICE_PID`、`$LOCAL_SERVICE_PIDS`、`$LOCAL_SERVICE_PORTS` |
| 随 magpie 启动 | boolean | 关 | 每个 magpie 会话只自动启动一次 |
| 启动队列 | number | `1` | 1–99，自动启动时从小到大分批 |
| 首页地址 | string（HTTP(S) URL） | — | 列表首页按钮的打开地址；留空时使用 GitHub 仓库 |
| GitHub 仓库 | `owner/repo` | — | 绑定后才检查新版本 |
| 当前版本 | string | 自动检测 | 由版本命令得出，也可手填 |
| 版本命令 | string | 自动检测 | 手动修改即关闭自动检测 |
| 更新命令 | string | — | 点「立即更新」时执行 |

</details>

<details>
<summary><b>数据存储、令牌与安全边界</b></summary>

- **数据目录**：`<magpie 配置目录>/local-services/`，含 `services.json`、`runtime.json`、`logs/`、`tunnels/`。
- **面板令牌**：首次打开时生成，保存在 magpie `plugins.json` 中本插件的选项里；每个 API 请求均需携带 `x-local-services-token`。
- **GitHub 令牌**：单独存为权限 `0600` 的文件，不写入 `services.json`，也不进日志；面板仅展示末 4 位。
- **网络边界**：管理面板仅监听 `127.0.0.1` 并校验 `Host` 头，防止其他网页跨站操作本地服务；「打开链接」仅放行 GitHub 与本插件创建的隧道地址。
- **公网提醒**：隧道开启后即成为公网入口，持有链接的人均可访问对应本地端口，联调或演示结束后请及时关闭。

</details>

<details>
<summary><b>运行架构与守护原理</b></summary>

```
magpie 窗口
└─ 侧边栏页面 page/（沙盒框架，不能联网）
     └─ 准备令牌后跳转 ──▶ 插件宿主（Bun）
                          ├─ lib/server.mjs   127.0.0.1:3427 面板 web/ 与 API
                          ├─ lib/manager.mjs  启停、启动队列、更新检查
                          ├─ lib/process.mjs  进程标记与进程组追踪
                          ├─ lib/tunnel.mjs   cloudflared 快速隧道
                          ├─ lib/github.mjs   Release 查询与令牌
                          └─ lib/store.mjs    services.json、日志、设置
```

- **服务解耦守护**：服务以独立进程组运行并注入 `LOCAL_SERVICE_ID` 环境标记，输出直接写日志文件，不随 magpie 退出而中断；新的插件宿主启动后按 `runtime.json` 与进程标记自动重新接管。
- **隧道生命周期**：隧道随插件宿主退出而关闭；若宿主被强杀，下次启动会按 `tunnels/tunnels.json` 核对命令行后精确清理遗留进程，不会误杀用户自己运行的 `cloudflared`。
- **单宿主接管**：仅 magpie 主应用宿主（`magpie` / `tray` / `serve` / `web` / `daemon` / `tui`）负责监控与自动启动；终端执行 `magpie plugin …` 等短命命令不会抢占接管权。
- **日志格式**：合并 stdout / stderr，插件自身操作记录以 `▸` 开头。

</details>

---

## 本地开发与调试

运行测试：

```bash
bun test
```

在隔离沙箱中试跑（不影响日常正在使用的 magpie 实例；先在沙箱配置目录初始化 `plugins.json`，避免触发便携目录回退）：

```bash
sb=$(mktemp -d); mkdir -p $sb/.config/magpie; echo '{"plugins":[]}' > $sb/.config/magpie/plugins.json
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 LOCAL_SERVICES_PORT=3528 magpie "$@"; }
m plugin add ./ </dev/null && m web --addr 127.0.0.1:3531
```

欢迎提交 Issue 与 PR · MIT License

---

<sub>English: Stop juggling terminal windows — manage, supervise, and auto-update all your long-running local services right inside magpie, and share any local port to the public internet in one click via free Cloudflare quick tunnels. macOS only.</sub>
