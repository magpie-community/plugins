# Magpie Clean Login · 干净登录

**简体中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/@gruu6y/page-clean-login?style=flat-square&logo=npm)](https://www.npmjs.com/package/@gruu6y/page-clean-login)
[![tag](https://img.shields.io/github/v/tag/Gruu6y/magpie-clean-login?style=flat-square)](https://github.com/Gruu6y/magpie-clean-login/tags)
[![ci](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml/badge.svg)](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**一句话：通过独立的指纹浏览器，在插件页面接管 [magpie](https://usemagpie.ai) 的多账号登录与续期——每个账号一套固定浏览器指纹、一条独立网络出口，缓解多账号关联与封号焦虑。**

如果你只用一个账号，magpie 本身就够了。如果你要同时维护多个账号（例如多个 WorkBuddy、Qoder、Codex 等），就需要它把每个账号隔离开。

![干净登录的供应商页：标签页、一次性的登录浏览器准备，以及可以直接开始登录的供应商卡片](assets/screenshot-providers.png)

> **非官方插件声明：** 本插件由 [Gruu6y](https://github.com/Gruu6y/magpie-clean-login) 独立开发维护，**不是** magpie 官方或 `magpie-community` 发布的项目。npm 包 [`@gruu6y/page-clean-login`](https://www.npmjs.com/package/@gruu6y/page-clean-login) 是 magpie 的插件分发包（非独立 JS 库）。代码完全开源，欢迎审计、提 issue 与 PR。

> **重要供应商提醒：**
> - **Claude 系（`claude` / `claudecode` 等）**：**请不要通过本插件使用 Claude，请改用 `claude-cage`。**
> - **Google Antigravity / AGY 系（`antigravity` / `agy-cli` 等）**：未实付的账号无法通过本插件缓解封禁焦虑，且暂时不建议通过 magpie 使用 AGY 供应商。

<a id="tldr"></a>

## 30 秒速览（人类 & Agent 统一入口）

| 维度 | 事实 |
| --- | --- |
| **定位** | magpie 非官方页面插件（Page + 本地回环服务）+ 零依赖 CLI / Agent HTTP 接口 |
| **npm 包名 / 仓库** | `@gruu6y/page-clean-login` · [GitHub](https://github.com/Gruu6y/magpie-clean-login) |
| **人类安装入口** | magpie → **Plugins** → **Discover** → **Unofficial** → 搜索 **Clean Login** 安装 |
| **支持平台** | **Windows x64** · **macOS（Apple Silicon 完整验证 / Intel 尽力支持）** · **Linux x64 / arm64** |
| **运行时与浏览器** | Bun **≥ 1.4.2**；内置一次性下载的精简 Camoufox（`158.0.1-beta.41`，153–176 MB，sha256 校验） |
| **核心页面** | **供应商** · **代理 IP** · **账号** · **使用说明**（四语言，自动跟随 magpie 深浅色） |
| **Agent 一步接入** | 默认回环服务 `http://127.0.0.1:3492`；运行 `clean-login agent` 或 `GET /api/agent`（带 `x-clean-login-token`）获取全量紧凑 JSON 摘要；异步接口支持 `--wait` / `?wait=<ms>` 免轮询 |
| **核心边界** | 一个账号、一套固定指纹、一条固定出口；**不绕过验证、不替你注册账号、零遥测** |

<a id="contents"></a>

## 目录

- [30 秒速览（人类 & Agent 统一入口）](#tldr)
- [它解决什么问题](#what)
- [为什么用它](#why)
- [环境要求与平台支持](#requirements)
- [安装（magpie 与 npm 说明）](#install)
- [快速开始](#quick-start)
- [核心页面一览](#tabs)
- [核心功能与防关联机制](#features)
- [Agent 与命令行接口（CLI / HTTP API）](#cli)
- [排查问题](#troubleshooting)
- [隐私、数据目录与环境变量](#privacy)
- [参与贡献](#contributing)
- [许可](#license)

<a id="what"></a>

## 它解决什么问题

在 magpie 里正常登录一个 AI 服务时：弹出系统浏览器 → 输入账号密码 → 登录完成 → 凭据写进 magpie。

单个账号这样没问题，**但登录第二个账号时，关联风险就开始累积：**

- 供应商记录的不只是出口 IP，还包括浏览器指纹（显卡、字体、分辨率、canvas 渲染等），合在一起几乎相当于一台设备的身份证号。
- 用同一个浏览器登账号 A 再登账号 B，在供应商眼里就是**同一台机器上的两个账号**。
- 凭据到期后的**续期**，以及登录后 magpie 发出的日常请求，如果继续共用同一套身份和全局出口，等于反复提醒对方这些账号同源。

**干净登录的做法很直接：把每个账号关进它自己独立的浏览器身份和固定出口里。**

| 环节 | 不用干净登录 | 用干净登录 |
| --- | --- | --- |
| 浏览器身份 | 所有账号共用一套指纹与 Cookie | 每账号独立持久 Profile 与固定指纹，登录后锁定 |
| 登录与日常出口 | 跟随系统 / magpie 全局设置 | 登录过程走指定代理，登录后自动同步到 magpie 单账号出口（热生效） |
| 退出再登录 | 容易变成一台“新电脑” | 保留身份与 Profile，**沿用旧指纹**回来 |
| 凭据续期 | 统一运行时刷新，容易暴露关联 | 可按账号开通**续期托管**，到期前在原指纹 + 原出口下静默重登 |

<a id="why"></a>

## 为什么用它

**因为 magpie 自身刻意不做这件事。** magpie 的维护者不希望与供应商对抗，因此不会去遮掩“同一台机器登录多个账号”的事实。这是产品取舍，不是 bug。

干净登录补上的正是这一层隔离：

1. **一账号即一设备。** 每个账号有独立的 `identity.json` 与持久化浏览器目录，退出登录不会丢弃身份。确实想让某个账号彻底变成一台“新电脑”时，再手动点 **更换指纹**。
2. **你选的出口就是真实出口。** HTTP/HTTPS 代理会同时接管隔离浏览器和插件自身发起的授权/换码请求；选“直连”就强制直连，绝不悄悄回退到 magpie 全局代理；登录完成后还会自动写入 magpie 的 `providers.json` 单账号出口（`accountProxies`），无需重启 magpie 即刻热生效。
3. **自动跟随你的供应商生态。** 直接扫描你已安装的 magpie 供应商插件与市场目录，无需手工维护名单。

> **说清边界：** 一个账号、一个指纹、一个出口。服务怎么风控仍由供应商决定——**本插件不绕过任何验证，也不替你注册账号。**

<a id="requirements"></a>

## 环境要求与平台支持

| 项目 | 要求 |
| --- | --- |
| 宿主 | [magpie](https://usemagpie.ai)（带 Plugins 面板） |
| 操作系统 | **Windows x64 · macOS（Apple Silicon / Intel）· Linux x64 / arm64** |
| 运行时 | Bun **≥ 1.4.2**（仅运行随附 CLI 时，Node 18+ 或 Bun 均可） |
| 磁盘空间 | 首次下载 **153–176 MB**（随平台而定），安装阶段需要约 **1 GB** 可用空间（含浏览器解压、约 213 MB `fpgen` 指纹模型与 256 MB 安全余量），仅需一次 |
| 网络 | 仅用于你显式发起的操作：代理测速、信任分与身份检测、登录浏览器下载、供应商登录 |

各平台精简 Camoufox（`158.0.1-beta.41`，解包前强制校验固定 sha256）实测包体：

| 平台与架构 | 压缩包下载 | 解压后大小 | 验证状态 |
| --- | --- | --- | --- |
| **Windows x64** (`win32:x64`) | ~176 MB | ~433 MB | 完整验证 |
| **macOS Apple Silicon** (`darwin:arm64`) | ~154 MB | ~378 MB | 完整验证（含真实 macOS Camoufox + WKWebView E2E，日常推荐） |
| **macOS Intel** (`darwin:x64`) | ~162 MB | ~398 MB | 尽力支持（Rosetta 2 冒烟通过，按进程架构自动命中） |
| **Linux x64** (`linux:x64`) | ~159 MB | ~395 MB | 完整验证 |
| **Linux arm64** (`linux:arm64`) | ~153 MB | ~371 MB | 完整验证 |

> **macOS 精简包说明：** 精简构建移除了上游 zip 内约 2.1 GB 的 `Camoufox.app/Contents/Resources/fonts/` 多余字体包并保留系统/哨兵字体。上游 macOS 包无代码签名，插件侧也不做 notarize，Gatekeeper 不拦截未带隔离属性的文件。构建脚本见 [`scripts/build-slim-artifact.mjs`](scripts/build-slim-artifact.mjs)，产物校验清单见对应 release 的 `inventory.json`。暂不支持其他架构，需要请提 [issue](https://github.com/Gruu6y/magpie-clean-login/issues)。

<a id="install"></a>

## 安装（magpie 与 npm 说明）

### 在 magpie 中安装（推荐）

1. 打开 magpie → **Plugins** → **Discover** → **Unofficial**（非官方插件）。
2. 找到 **Gruu6y** 发布的 **Clean Login**，点击 **Install**（列表未同步时点 **Retry**）。
3. 从左侧栏打开 **Clean Login**，进入插件页面。

### 关于 npm 包 `@gruu6y/page-clean-login`

- 本仓库通过标签 `vX.Y.Z` 自动发布至 npm：[`@gruu6y/page-clean-login`](https://www.npmjs.com/package/@gruu6y/page-clean-login)（[版本历史 / Tags](https://github.com/Gruu6y/magpie-clean-login/tags)）。
- **面向普通用户**：这是 magpie 安装插件时拉取的分发包，**不需要**自己手动 `npm install`。
- **面向脚本与 Agent**：安装进 magpie 后，插件目录里自带零依赖 CLI（`bin/clean-login.mjs`），无需额外装包即可直接驱动本地服务（详见 [Agent 与命令行接口](#cli)）。

<a id="quick-start"></a>

## 快速开始

走完下面四步大约 5 分钟（大部分时间在等浏览器首次下载）。

### 第 1 步：准备登录浏览器（只做一次）

打开插件的 **供应商** 页，在顶部 **登录浏览器设置** 卡片点击 **准备浏览器**：

- 下载对应平台的精简 Camoufox（**153–176 MB**，sha256 校验）与 `fpgen` 指纹模型（约 1.56 MB），解压到插件独立缓存目录，不影响你日常用的浏览器。
- 徽标变为 **已就绪** 即完成；中途可取消，失败可重试。

### 第 2 步：添加并测试代理出口

切到 **代理 IP** 页：

- **单条添加**：点 **添加代理**，填写名称、类型（HTTP / HTTPS / SOCKS5）、主机、端口及可选认证信息（支持 IPv6）。
- **批量导入**：点 **批量导入**，每行粘贴一条（支持 `http://user:pass@host:port#备注`、`备注|url`、`host:port`、`host:port:user:pass`、`user:pass@host:port` 等格式，支持 `#` / `//` 注释），单批最多 200 条，自动跳过重复连接，可统一设置默认类型与名称前缀。
- **测速与验证**：单行点 **测试** 或顶部点 **全部测试**（可随时取消）。

![代理 IP 页：右上角选择测速目标，下面是每条出口的实测结果、地区筛选和操作按钮](assets/screenshot-proxies.png)

几个值得留意的细节：

- **测速目标**：默认测“通用（出口检测）”，返回真实出口 IP、地区与延迟；也可切换到某家供应商，直接测到**那家 API 主机**的往返延迟。
- **`~` 握手标记**：像 `JP 静态 01` 上的 `~512 ms` 这样带波浪号的数字，表示只完成了 TLS 握手但未拿到 HTTP 响应（常见于 WAF 拦截），这是下限参考值而非完整请求延迟。
- **绝不静默降级**：代理不通或认证失败时直接报错，不会悄悄走直连。

### 第 3 步：选供应商并登录

回到 **供应商** 页，可按关键词搜索或用分类筛选（**全部 / 可登录 / 已有账号 / 市场目录**），点目标卡片上的 **添加账号**：

1. **选代理出口**：下拉会标出实测延迟，并把**这家供应商尚未用过的出口**排在前面。
2. **选方式 / 填字段**：若该供应商有多种登录路径（如站点登录、团队版、复用桌面会话、粘贴密钥）或需先填参数（手机号、站点、密钥），按提示填写后点 **开始登录**。
3. **完成登录**：浏览器登录会弹出隔离窗口，登录完自动收尾（关闭窗口即取消）；一次性验证码方式回到对话框输入并点 **提交验证码**。
4. 成功后提示 **登录完成，凭据已写入 magpie**，同时该账号的出口会自动同步到 magpie 的 `providers.json` 并热生效。

> 卡片上没有 **添加账号**？卡片会写明原因——通常是市场目录里的插件尚未在 magpie 安装（可点卡片安装或用 CLI `market install`），或该插件未暴露可驱动的登录方式。

### 第 4 步：在「账号」页确认身份干净

切到 **账号** 页，可以看到每个账号锁定的指纹、凭据到期状态、上次登录出口、当前生效出口、检测评级与续期托管状态。

![账号页：按供应商筛选、A/B/C/D 判定图例、每个账号固定的指纹、上次登录的地区与出口](assets/screenshot-accounts.png)

- **身份检测**：点行内 **检测** → **开始检测**，插件会用该账号固定的指纹通过指定出口访问第三方站点 `who.1ms.dog`，返回 **A 干净·可以用 / B 可用·有痕迹 / C 建议换出口 / D 不要用这个出口**。拿到 C/D 建议换出口重登。
- **普通重登 vs 更换指纹**：普通的「重新登录」会**沿用旧指纹**；只有点 **更换指纹** 才会抽一套新指纹重登并删除旧浏览器配置（且仅在前置检查与浏览器启动就绪后才替换，失败不会破坏旧配置），账号和凭据都会保留。

> **免责口径：** `who.1ms.dog` 是第三方站点的第二意见，**不等于供应商风控结论，也不是本插件自建的指纹评分。**

<a id="tabs"></a>

## 核心页面一览

| 页面 | 用途与核心能力 |
| --- | --- |
| **供应商 (`Providers`)** | 汇总已安装供应商插件与 magpie 市场目录；支持搜索与分类筛选（全部 / 可登录 / 已有账号 / 市场目录）、一次性准备登录浏览器、查看特化风险提醒、以及一键 **报告问题**（本地脱敏拼好 GitHub Issue 草稿）。 |
| **代理 IP (`Proxy IPs`)** | 管理 HTTP / HTTPS / SOCKS5 出口；支持单条添加与 **批量导入**（最多 200 条/批，自动去重）、单条测试与 **全部测试**、按供应商 API 测速、获取 Claude 信任分（`ip.net.coffee/claude`，0–100）；支持按地区、名称标签（家宽/静态）、延迟区间、关键词、状态（可用/失败/未测）、使用情况（使用中/未使用）组合筛选与多维排序。 |
| **账号 (`Accounts`)** | 查看每个账号的固定指纹、到期倒计时、登录/生效出口与检测记录；支持 **导入 magpie 已有账号**（同时覆盖 `plugin-auth.json` 与 `logins.json`，预览与导入同源）；支持按供应商（含可搜索的 **更多供应商**）、状态（已登录 / 已退出 / 续期已暂停 / 即将到期）、搜索与排序组合筛选；提供单账号出口修改（跟随 / 直连 / 指定代理）、备注、`who.1ms.dog` 身份检测、**续期托管** 与 **更换指纹**。 |
| **使用说明 (`Guide`)** | 页内自带 11 节首次使用说明书，英文、简体中文、繁體中文、日本語四份独立撰写；纯文本页面，不联网、不下载、不执行任何操作。 |

![使用说明页：页内十一节说明书的第一节，讲清为什么要开发这个插件](assets/screenshot-guide.png)

> **关于 README 截图：** 本页中文截图与英文 README 的英文截图均由本仓库真实代码在 Chrome 中直接渲染，无手绘、无拼接。为避免泄露本机信息，图中仅采用**演示数据**：代理与账号使用 RFC 5737 文档保留网段 IP（`203.0.113.x`、`198.51.100.x`、`192.0.2.x`）与虚构账号名；登录浏览器面板的安装路径与可用磁盘使用**中性值**（`C:\Users\Public\…` 与 `256 GB`）。其余状态徽标、包体大小、供应商卡片、图标与文案均为真实计算结果。运行 `bun scripts/shoot-readme-screenshots.mjs --lang zh-Hans` / `--lang en`（[`scripts/shoot-readme-screenshots.mjs`](scripts/shoot-readme-screenshots.mjs)）可重现中英文全部截图。

<a id="features"></a>

## 核心功能与防关联机制

### 登录与反关联加固

- **双腿出口一致**：HTTP / HTTPS 出口同时接管 Camoufox 浏览器与插件自身的 `authorize()` / `callback()` HTTP 请求；“直连”显式绕过 magpie 全局代理。**SOCKS5 出口仅能接管浏览器窗口**（受 Bun `fetch` 代理协议限制），插件会在界面与状态中给出明确非致命提示，需要全程同出口时请使用 HTTP / HTTPS 代理。
- **magpie 单账号出口自动同步**：登录完成后自动写入 magpie 的 `providers.json`（`providers[].accountProxies`），magpie 监听文件变更热重载无需重启。切回直连登录时会自动清掉旧代理绑定写入 `"direct"`；修改代理连接信息或密码后自动重同步所有绑定账号；删除账号时自动清理其出口覆盖与续期策略；服务启动时仅补齐缺失项，不覆盖你在 magpie 里手工配置的出口。
- **安全指纹轮换**：**更换指纹**只在插件加载、参数校验、`authorize()` 与浏览器可执行文件全部就绪后才轮换并删除旧 Profile，前置失败绝不损坏现有身份。
- **多形态登录支持**：兼容 OAuth 浏览器登录、设备码、短信/邮箱一次性验证码（带超时回收，等待期目录受保护不被误清理）、多路径选择，以及 magpie 内置供应商原生登录（自动接管打印出的 OAuth 链接）。
- **脱敏问题反馈**：卡片上的 **报告问题** 在本地白名单拼装无凭据的 Issue 正文并打开 GitHub 新建页，提交前可全文预览（详见 [docs/reporting.md](docs/reporting.md)）。

### 续期托管（默认关闭，按账号独立开通）

- **默认全关、绝无一键全开**：只有在 **账号** 页进入单个账号的 **续期托管** 并点击 **开通托管**，该账号才会被接管。
- **原指纹 + 原出口静默续期**：在凭据**到期前**以 headless 方式重跑一次该账号自己的完整登录——沿用同一份 `identity.json`、同一个持久 Profile、登录时记下的同一条出口（直连仍直连），通过与手动登录完全相同的锁写回 magpie。
- **不与 magpie 抢 refresh token**：托管走完整登录（authorize → callback），不使用 refresh token；若 magpie 先续期，托管会自动读取新到期时间并顺延。
- **按凭据寿命动态提前**：1 小时级提前 15 分钟；1 天级提前约 72 分钟（5%，15 分钟–12 小时区间）；≥10 天（如半月/月期）**提前 5 天**开始续期，给临时波动留足重试窗口。
- **护栏与自停**：全局串行，绝不与手动登录或身份检测并发；同账号两次尝试间隔 ≥30 分钟且**不设每日上限**；未过期前的临时失败按指数退避重试，不会轻易关停；只有**过期后仍连续失败**、遇到需人工介入（验证码 / 设备码 / 一次性码）、或续期回来的账号身份与指纹绑定不一致时，才会拒绝写回、自动暂停并在页面顶部提示原因。
- 对话框支持 **立即续期**、**停止这次续期**、**关闭托管**，并保留最近 10 次续期记录。

![续期托管对话框：已开通的账号、凭据到期时间、使用的出口与指纹，以及续期记录](assets/screenshot-hosting.png)

### 日常使用体验

- **离线品牌图标**：内置 magpie 供应商图标集（`assets/icons/`，来源索引见 `assets/icons/index.json`，归属声明见 `assets/icons/NOTICES.md`），随主题自动着色，绘制图标零网络请求。
- **四语言 & 主题热同步**：支持 English、简体中文、繁體中文、日本語，语言与深浅色均实时跟随 magpie。

<a id="cli"></a>

## Agent 与命令行接口（CLI / HTTP API）

**不想点页面？直接让你的 AI Agent 驱动干净登录。** 插件自带零依赖命令行客户端与面向程序的紧凑 HTTP 接口，只依赖全局 `fetch`（Bun / Node 18+ 均可，毫秒级启动，不加载 Camoufox 模块）。

### 给 Agent 的 3 步快速接入

1. **找到 CLI 入口（无需重装依赖）**：
   - 已通过 magpie 安装（推荐）：`bun ~/.config/magpie/plugins/node_modules/@gruu6y/page-clean-login/bin/clean-login.mjs <命令>`（或改用 `node`）
   - 在本仓库源码目录内：`bun bin/clean-login.mjs <命令>`
   - 若已全局安装 npm 包：`clean-login <命令>`
2. **一次调用拿全局状态**：运行 `agent`（对应 `GET /api/agent`），一次返回版本号、服务端口、命令目录、浏览器准备状态、在途任务、供应商卡片、代理列表（不含密码）、账号列表、以及损坏恢复告警（`recovered`），省去四语言冗余文案。
3. **用 `--wait` / `?wait=<ms>` 替代轮询循环**：所有异步操作支持阻塞等待直到任务落定或需要调用方输入（`waiting-code` / `paste-required`）。CLI 裸 `--wait` 默认等 `60000` ms；HTTP `?wait=<ms>` 服务端上限 `120000` ms。

### 连接、鉴权与输出契约

- **默认地址**：`http://127.0.0.1:3492`（可通过 `--port` / `--url` 或环境变量 `CLEAN_LOGIN_PORT` / `CLEAN_LOGIN_URL` 覆盖）。
- **自动鉴权**：访问本机回环地址时，CLI 自动从服务首页 `<meta name="clean-login-token">` 读取每进程随机 token 并通过请求头 `x-clean-login-token` 发送，**从不打印 token**。连接非回环远端服务（如 `magpie web`）时，CLI 拒绝自动抓取，必须显式传 `--token <HEX>`。
- **机器可读输出**：成功时 stdout 输出合法 JSON（加 `--raw` 输出单行紧凑 JSON），退出码 `0`；失败时 stderr 输出单行 JSON `{"error":"...","status":...,"message":"..."}`，退出码 `1`（注：`proxy test` 收到 `ok: false` 也会返回退出码 `1`）。
- **账号参数约定**：操作单个账号的命令（`accounts exit` / `note` / `delete`、`check`）均以 `<provider> <key>` **两个独立位置参数**传参（CLI 会自动 URL 编码，确保 key 里的 `#` 不被截断）；仅 `accounts import run --only <provider>#<recordId>` 使用单段复合键（可重复传参）。

### 完整 CLI 命令速查表

| 分类 | 命令 | 说明 |
| --- | --- | --- |
| **总览与健康** | `agent` / `status` / `providers` | 服务紧凑摘要（`GET /api/agent`）/ 健康检查 / 供应商卡片列表 |
| **代理管理** | `proxies` | 查看所有代理（不含密码，仅 `hasPassword`） |
| | `proxies add <name> <type> <host> <port> [--user U] [--pass P]` | 添加代理（`http\|https\|socks5`；端口为位置参数，避免与服务 `--port` 冲突） |
| | `proxies import [--file PATH \| <text>] [--type T] [--prefix P]` | 批量导入代理（文本或 UTF-8 文件，自动去重） |
| | `proxies update <proxyId> [--name N] [--type T] [--host H] [--exit-port P] [--user U] [--pass P] [--clear-password]` | 修改代理（改连接会清空探测结果并重同步绑定账号；代理端口用 `--exit-port`） |
| | `proxies delete <proxyId>` / `proxies targets` | 删除代理 / 查看可测速的供应商目标 |
| **代理探测** | `proxy test <proxyId> [--provider ID]` | 实测代理连通性（可选测到指定供应商 API） |
| | `proxy score <proxyId> [--wait ms]` / `score status [--wait ms]` / `score cancel` | 启动、查询或停止 Claude 信任度评分 |
| **账号管理** | `accounts` | 列出已知账号与登录状态 |
| | `accounts import plan` / `accounts import run [--only <provider>#<recordId>]...` | 预览或执行从 magpie 导入已有账号（预览与导入走同一函数） |
| | `accounts exit <provider> <key> [--mode inherit\|direct\|custom] [--proxy ID]` | 查看或设置账号生效出口 |
| | `accounts note <provider> <key> <text>` / `accounts delete <provider> <key>` | 设置备注 / 删除已退出账号 |
| | `accounts prune` / `accounts hosting` | 清理无凭据孤立目录 / 查看续期托管策略与在途任务 |
| **登录流程** | `signin start --provider ID [--proxy ID] [--method LABEL] [--input k=v]... [--single] [--wait ms]` | 启动插件供应商隔离登录 |
| | `signin status [--wait ms]` / `signin code <code>` / `signin cancel` | 查询登录状态 / 提交一次性验证码 / 取消登录 |
| | `native start --provider ID [--wait ms]` / `native status [--wait ms]` / `native paste <text>` / `native cancel` | 驱动 magpie 原生供应商登录（粘贴回调链接或代码） |
| **环境与检测** | `env [--wait ms]` / `env prepare [--wait ms]` / `env cancel` | 查询、启动或取消一次性登录浏览器下载 |
| | `check <provider> <key> [--wait ms]` | 查询账号 `who.1ms.dog` 身份检测任务 |
| **市场与反馈** | `market status` / `market install <package>` | 查询市场安装任务 / 从 magpie 市场安装供应商插件 |
| | `report --provider ID [--note TEXT] [--language LANG]` | 生成脱敏的供应商问题报告正文 |

### 常用命令示例

```sh
# 1) 一步读取全局状态（推荐 Agent 首条命令）
bun bin/clean-login.mjs agent

# 2) 准备浏览器并等待完成
bun bin/clean-login.mjs env prepare --wait

# 3) 管理代理：单条添加、批量导入、修改、测速与信任分
bun bin/clean-login.mjs proxies add 家宽01 http 127.0.0.1 7102
bun bin/clean-login.mjs proxies import --file ./exits.txt --type http --prefix HK
bun bin/clean-login.mjs proxies update <proxyId> --host 10.0.0.2 --exit-port 1080
bun bin/clean-login.mjs proxy test <proxyId> --provider workbuddy
bun bin/clean-login.mjs proxy score <proxyId> --wait

# 4) 账号导入、登录、验证码、出口与备注
bun bin/clean-login.mjs accounts import plan
bun bin/clean-login.mjs accounts import run --only <provider>#<recordId>
bun bin/clean-login.mjs signin start --provider workbuddy --proxy hk-home-1 --wait
bun bin/clean-login.mjs signin code 123456
bun bin/clean-login.mjs accounts exit <provider> <key> --mode custom --proxy <proxyId>
bun bin/clean-login.mjs accounts note <provider> <key> 备用号
bun bin/clean-login.mjs accounts delete <provider> <key>

# 5) 维护与任务控制
bun bin/clean-login.mjs accounts prune
bun bin/clean-login.mjs accounts hosting
bun bin/clean-login.mjs env cancel
bun bin/clean-login.mjs score cancel
```

### 直接调用 HTTP API（给无 Shell 的 Agent）

所有 `/api/*` 路由均要求请求头 `x-clean-login-token: <token>`，常见入口：

- **紧凑总览**：`GET /api/agent`、`GET /api/health`
- **支持 `?wait=<ms>` 阻塞等待的异步路由**：
  - `GET /api/signin?wait=<ms>`（启动 `POST /api/signin`，提交验证码 `POST /api/signin/code`，取消 `POST /api/signin/cancel`）
  - `GET /api/native-signin?wait=<ms>`（启动 `POST /api/native-signin`，粘贴 `POST /api/native-signin/paste`，取消 `POST /api/native-signin/cancel`）
  - `GET /api/proxy-score?wait=<ms>`（启动 `POST /api/proxies/:id/score`，取消 `POST /api/proxy-score/cancel`）
  - `GET /api/environment/job?wait=<ms>`（启动 `POST /api/environment/prepare`，取消 `POST /api/environment/cancel`）
  - `GET /api/accounts/:provider/:key/check?wait=<ms>`（启动 `POST /api/accounts/:provider/:key/check`，取消 `POST .../check/cancel`）
- **其他读写路由**：`/api/proxies`（及 `/api/proxies/bulk`、`/api/proxies/:id/test`）、`/api/accounts`（及 `/import/plan`、`/import`、`/prune`、`/hosting`、`/:provider/:key/exit`、`/:provider/:key/hosting`）、`/api/market/install`、`/api/report`。
- **并发护栏**：同一时间只允许 1 个登录 / 检测 / 续期任务运行，冲突时返回 `409`。完整 CLI 帮助请跑 `bun bin/clean-login.mjs help`。

<a id="troubleshooting"></a>

## 排查问题

| 现象 | 怎么办 |
| --- | --- |
| 某张供应商卡没有 **添加账号** | 卡片上会写明原因：市场条目需先在 magpie 安装对应插件；已安装插件则需暴露可驱动的登录方式。 |
| 登录浏览器显示*未安装* / 下载失败 | 首次运行会下载对应平台的精简包（153–176 MB：Windows x64 约 176 MB、macOS x64 约 162 MB、macOS arm64 约 154 MB、Linux x64 约 159 MB、Linux arm64 约 153 MB），解包前做 sha256 校验。请检查约 1 GB 可用磁盘空间与网络后重试。 |
| 登录报错 `no_url` 或 `method_input_required` | 该供应商登录方式要求先填字段（手机号、站点、密钥）。补全后重试；仍失败请点卡片上的 **报告问题**。 |
| 选了 SOCKS5 代理，提示插件请求未走该代理 | 运行时 `fetch` 仅支持 HTTP/HTTPS 代理，SOCKS5 只能带浏览器窗口。要求全程同出口请改用 HTTP/HTTPS 代理。 |
| 代理测试失败 | 测试直接走该代理真实建连，绝不退回直连。检查主机、端口、账号密码，以及出口能否访问目标站点。 |
| 延迟数字前带 `~` | 表示只完成了 TLS 握手但未拿到 HTTP 响应（常见于目标 WAF 拦截），不是完整请求耗时，建议换一条出口。 |
| 已登录账号看起来像新机器 / 想真的换一台机器 | 普通「重新登录」会**沿用旧指纹**；到 **账号** 页核对固定指纹即可。真要换一台机器，在已登录行点 **更换指纹**：抽新指纹重登并删旧配置，账号与凭据不变。 |
| 身份检测拿到 C 或 D | 这条出口不够干净，换一条代理出口重新登录该账号。 |
| 续期托管自动暂停了 | 点开该行 **续期托管** 查看具体原因（如需要验证码/设备码、账号身份不匹配、过期后连续失败），处理完后手动重新开通即可。 |
| 其他问题 | 提交 [issue](https://github.com/Gruu6y/magpie-clean-login/issues)，附上预期行为、实际现象、涉及供应商/代理及脱敏报错截图。**切勿粘贴真实 token、Cookie 或代理密码。** |

<a id="privacy"></a>

## 隐私、数据目录与环境变量

- **零遥测、无云端账号**：除你主动发起的动作（代理测速、信任分、身份检测、浏览器下载、供应商登录）外，插件不向外发任何请求。
- **数据存放位置**：
  - 代理、账号台账、固定指纹、独立 Profile 与续期策略（`renew-hosting.json`，仅开关/时间/结果，无凭据）均存于 `~/.config/magpie/magpie-clean-login/`。
  - 市场目录读取自 `~/.cache/magpie/`；单账号出口同步写入 `~/.config/magpie/providers.json`。
  - 登录浏览器与指纹模型缓存位置：Windows `%LOCALAPPDATA%/magpie-clean-login/camoufox` · macOS `~/Library/Caches/magpie-clean-login/camoufox` · Linux `$XDG_CACHE_HOME/magpie-clean-login/camoufox`。
- **凭据安全**：代理密码仅存本机且永不回传页面或写入日志；每进程生成独立页面 token，且页面仅允许嵌入 magpie 沙箱 frame 中运行。

### 环境变量一览

| 环境变量 | 用途 |
| --- | --- |
| `MAGPIE_CONFIG_DIR` | 覆盖 magpie 配置根目录（默认 `~/.config/magpie`） |
| `MAGPIE_CLEAN_LOGIN_DATA` | 覆盖本插件数据目录（默认 `<MAGPIE_CONFIG_DIR>/magpie-clean-login`） |
| `MAGPIE_CACHE_DIR` | 覆盖 magpie 市场缓存目录（默认 `~/.cache/magpie`） |
| `MAGPIE_CLEAN_LOGIN_BROWSER_DIR` | 覆盖登录浏览器与 `fpgen` 模型缓存目录 |
| `MAGPIE_CLEAN_LOGIN_BROWSER_URL` / `MAGPIE_CLEAN_LOGIN_BROWSER_SHA256` | 覆盖登录浏览器下载地址与 sha256 校验值（用于私有镜像） |
| `CAMOUFOX_EXECUTABLE_PATH` | 指定已存在的 Camoufox 可执行文件路径 |
| `MAGPIE_CLEAN_LOGIN_DISPLAY` | 无界面 Linux 未设 `DISPLAY`/`WAYLAND_DISPLAY` 时显式指定 X11 显示（如 `:99`） |
| `MAGPIE_CLEAN_LOGIN_FONTCONFIG` | Linux 覆盖字体配置：`system`（`/etc/fonts/fonts.conf`）或自定义 `fonts.conf` 路径（不覆盖已有 `FONTCONFIG_FILE`） |
| `CLEAN_LOGIN_URL` / `CLEAN_LOGIN_PORT` | 覆盖 CLI 目标服务地址 / 端口（默认 `http://127.0.0.1:3492`） |
| `MAGPIE_CLEAN_LOGIN_IP_ENDPOINT` | 覆盖通用出口测速地址 |
| `MAGPIE_CLEAN_LOGIN_PROXY_TIMEOUT_MS` / `MAGPIE_CLEAN_LOGIN_SCORE_TIMEOUT_MS` / `MAGPIE_CLEAN_LOGIN_CHECK_TIMEOUT_MS` | 覆盖代理测速 / 信任分 / 身份检测超时毫秒数 |

<a id="contributing"></a>

## 参与贡献

欢迎提交 PR。本仓库以完整测试套件为契约：提交前跑全量 `bun test`，功能与修复必须带测试。改动 `lib/`、`ui/`、`page/` 或 `index.mjs` **不要自己修改 `package.json` 的 `version`**——版本号由合并方在合并点统一分配并打 tag 自动发布 npm（`node scripts/check-version-bump.mjs` 会拦截降级或重复版本号）。动手前请先读 [AGENTS.md](AGENTS.md) 与 [docs/releasing.md](docs/releasing.md)。

<a id="license"></a>

## 许可

[MIT](LICENSE) © 2026 Gruu6y · [npm 包](https://www.npmjs.com/package/@gruu6y/page-clean-login) · [版本历史 / Tags](https://github.com/Gruu6y/magpie-clean-login/tags) · [反馈问题](docs/reporting.md) · [CI](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml)
