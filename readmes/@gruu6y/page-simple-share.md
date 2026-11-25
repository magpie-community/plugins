# Magpie Simple Share · 简单分享

**简体中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/@gruu6y/page-simple-share?style=flat-square&logo=npm)](https://www.npmjs.com/package/@gruu6y/page-simple-share)
[![tag](https://img.shields.io/github/v/tag/Gruu6y/magpie-simple-share?style=flat-square)](https://github.com/Gruu6y/magpie-simple-share/tags)
[![ci](https://github.com/Gruu6y/magpie-simple-share/actions/workflows/ci.yml/badge.svg)](https://github.com/Gruu6y/magpie-simple-share/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**一句话：面向 [magpie](https://usemagpie.ai) 的去中心化、零信任、开箱即用的跨网模型分享插件——不依赖中心化账号或第三方组网客户端，把本机已经配好的模型与额度安全地分享给异地家人或朋友。**

如果你只在自己电脑上用，或对方和你连在同一台局域网路由器下，magpie 自带的局域网网关就已经够了。如果你想把本机配好的模型与额度分享给异地亲友，又不想折腾公网 IP、Tailscale/ZeroTier 组网客户端，更不想把真实 API Key 或 `gateway-key` 发给对方，就需要它。

![简单分享的「我分享出去的」页面：本机分享开关、待处理 4 位配对码审批、已分享成员与展开后的按模型用量明细](assets/screenshot-owned.png)

> *截图使用演示台账与虚构主机数据生成（由 [scripts/shoot-readme-screenshots.mjs](scripts/shoot-readme-screenshots.mjs) 从真实插件页面渲染），不含任何本机信息。*

> **非官方插件声明：** 本插件由 [Gruu6y](https://github.com/Gruu6y/magpie-simple-share) 独立开发维护，**不是** magpie 官方或 `magpie-community` 发布的项目。npm 包 [`@gruu6y/page-simple-share`](https://www.npmjs.com/package/@gruu6y/page-simple-share) 是 magpie 的页面插件分发包（非独立 JS 库）。代码完全开源，欢迎审计、提 issue 与 PR。

> **重要使用与平台提醒：**
> - **个人订阅条款风险**：插件界面与首次开启确认框均明确区分 **API 供应商 / 路由组** 与 **个人订阅账号**。多数个人订阅条款限制多人共享或高并发复用，请仅限亲友小范围自用，并自行承担上游服务条款风险。
> - **Intel Mac（`darwin-x64`）说明**：上游 `@number0/iroh@1.2.0` 仅提供 Apple Silicon（`darwin-arm64`）原生二进制，Intel Mac 上无法启用模式 1（P2P），插件会自动提示并引导改用 **模式 2（自建盲中转）** 或 **模式 3（公网直连）**（零额外二进制）。

<a id="tldr"></a>

## 30 秒速览（人类 & Agent 统一入口）

| 维度 | 事实 |
| --- | --- |
| **定位** | magpie 非官方页面插件（Page + 本地回环控制面/桥接服务）+ 零依赖 CLI / HTTP 接口 |
| **npm 包名 / 仓库** | `@gruu6y/page-simple-share` · [GitHub](https://github.com/Gruu6y/magpie-simple-share) |
| **人类安装入口** | magpie → **Plugins** → **Discover** → **Unofficial** → 搜索 **Simple Share** 安装（或从源码通过 `magpie plugin add` 安装） |
| **支持平台** | **Windows x64 / arm64** · **macOS（Apple Silicon 全模式验证 / Intel 模式 2 & 3 可用）** · **Linux x64 / arm64 / armv7（自动识别 glibc 与 musl）** |
| **运行时与网络组件** | Bun **≥ 1.4.2**；模式 1 按需从国内镜像（`registry.npmmirror.com`，回退 `registry.npmjs.org`）下载 `@number0/iroh@1.2.0` 并强校验 `sha512`；模式 2 / 3 **零额外原生二进制** |
| **核心页面** | **我分享出去的** · **分享给我的** · **连接与安全**（离线零外链，自动跟随 magpie 深浅色） |
| **Agent 一步接入** | 默认回环服务 `http://127.0.0.1:3494`；运行 `magpie-simple-share doctor --json` 或 `status --json`（支持离线读本地状态）；HTTP `/api/*` 强制携带 `x-simple-share-token` |
| **核心边界** | **零中心化服务器、零虚拟网卡（No TUN）、真实密钥永不离开宿主、每次转发 Fail-Closed 验活、不记录提示词与回复正文** |

<a id="contents"></a>

## 目录

- [30 秒速览（人类 & Agent 统一入口）](#tldr)
- [它解决什么问题](#what)
- [为什么用它](#why)
- [环境要求与平台支持](#requirements)
- [安装（magpie 与 npm 说明）](#install)
- [快速开始](#quick-start)
- [核心页面一览](#tabs)
- [三种异地互通模式与盲中转部署](#modes)
- [核心功能与零信任安全机制](#features)
- [Agent 与命令行接口（CLI / HTTP API）](#cli)
- [排查问题](#troubleshooting)
- [隐私、数据目录与环境变量](#privacy)
- [参与贡献](#contributing)
- [许可](#license)

<a id="what"></a>

## 它解决什么问题

想把本机 magpie 里配好的模型分享给异地家人或朋友，常见土办法各有硬伤：

- **直接发 API Key 或导出 `gateway-key`**：密钥一旦外发就难以界定使用范围，还容易被转发或泄露；把本机 magpie 暴露到公网更是高危操作。
- **走第三方中转 / 商业分享平台**：必须注册母公司账号、把流量和凭据交给陌生服务器中转，既不放心隐私，也受制于平台存活。
- **拉组网 VPN（Tailscale / ZeroTier 等）**：双端都得装客户端、建虚拟网卡（TUN），不仅容易和本机梯子/代理工具冲突，还等于把对方设备放进了自家局域网。

**简单分享的做法很直接：双方只装一个 magpie 插件，在应用层用双向 Ed25519 公钥钉死加密直连，真实密钥永远不离开宿主电脑。**

| 环节 | 不用简单分享 | 用简单分享 |
| --- | --- | --- |
| 跨网门槛 | 需公网 IP + 端口映射，或双端装 VPN/组网客户端 | 双端仅需 magpie 插件，默认模式 1 自动 P2P 打洞 + 盲中转兜底 |
| 密钥安全 | 需把上游 Key 或 `gateway-key` 发给对方 | 真实密钥全程留在本机；宿主验明对方公钥后仅在本机 `127.0.0.1` 注入受限 key |
| 网络隔离 | 虚拟网卡（TUN）可能暴露局域网、与本机代理冲突 | **零虚拟网卡（No TUN）**，不改系统路由表，不把对方接入局域网 |
| 权限与止损 | 难以按人限模型/额度/并发，撤销后流式连接难断 | 按成员独立建受限 `gateway-key`；支持暂停、改额，**删除立即掐断进行中的 SSE 流** |
| 信任模型 | 依赖第三方账号体系或中心化中转解密 | 零账号；全模式强制双向 Ed25519 公钥钉死，中转仅见匿名密文字节流 |

<a id="why"></a>

## 为什么用它

**因为 magpie 自身专注于本机/局域网模型网关与多 Agent 统一接入，不会为你内置一套跨公网 P2P 打洞、邀请配对审批和零信任远程桥接体系。**

简单分享补上的正是“跨网把本机 magpie 安全借给亲友用”这一层：

1. **邀请码不含任何密钥，且带 4 位 SAS 人工防中间人核对。** 宿主生成的 `mshare1:...` 邀请码支持可选有效期（默认 5 分钟，可选 30 分钟方便未装软件的亲友安装，或 2 小时）、单次有效、输错 5 次立即烧毁作废；同时支持一键导出**离线 `.html` 邀请卡**（微信发文件零网络直接打开）或生成**在线邀请链接**（`#mshare1:...` 锚点仅留在浏览器本地，绝不发往服务器）。对方申请后双方核对 4 位安全配对码一致再点同意。
2. **宿主本机 Fail-Closed 验活，杜绝越权与降级。** 每次转发请求前先对本机回环 `/v1/magpie/limit` 验活，防止手工删掉 `gateway-key` 后意外退化为无限制放行；路径严格白名单，封死管理端、Memory 与 MCP。
3. **三条传输路径任选，严禁偷偷回落。** 没服务器用默认模式 1（Iroh QUIC P2P + 盲中转兜底）；有国内轻量云用模式 2（单文件盲转发器，免域名免备案）；有公网 IPv6/IPv4 用模式 3（纯 TLS 1.3 mTLS 直连）。选定模式 2 或 3 后，**绝不偷偷回落第三方公共节点**。
4. **接收端零手工配置。** 审批通过后插件自动在接收端起本地回环加密桥接，并调用 `magpie provider add` 写入 `remote-magpie` 供应商，接收端所有已接入 magpie 的 Agent 直接可用。

> **说清边界：** 本插件只负责安全的跨网加密转发与成员级限额隔离，**不提供免费模型、不绕过任何上游风控或账号条款、零遥测**。

<a id="requirements"></a>

## 环境要求与平台支持

| 项目 | 要求 |
| --- | --- |
| **宿主** | [magpie](https://usemagpie.ai)（支持桌面端与 Linux `--tui` / CLI，需支持 `gateway-key`、`remote-magpie` 与页面插件） |
| **操作系统** | **Windows（x64 / arm64）· macOS（Apple Silicon / Intel）· Linux（x64 / arm64 / armv7，自动识别 glibc 与 musl）** |
| **运行时** | Bun **≥ 1.4.2** |
| **默认端口** | 控制面 `127.0.0.1:3494`（插件选项 `port` 可改）；模式 3 默认监听 `3497`；模式 2 盲转发器默认 `3499` |
| **网络** | 仅用于你显式发起的操作：按需拉取 `@number0/iroh@1.2.0`（模式 1）、跨网配对与加密模型转发、连通性测试 |

各平台 `@number0/iroh@1.2.0` 原生组件映射与跨平台实测状态（安装前强制校验固定 `sha512`，防路径穿越原子解包）：

| 平台与架构 | 模式 1 原生包（`@number0/iroh@1.2.0`） | 模式 2 / 3（纯 Bun TLS 1.3 mTLS） | 实测验证状态 |
| --- | --- | --- | --- |
| **Windows x64** (`win32-x64`) | `@number0/iroh-win32-x64-msvc` | 原生支持（零额外二进制） | **完整验证**（`bun test` 57/57 通过，含双 `magpie serve` 与 Chrome E2E） |
| **Windows arm64** (`win32-arm64`) | `@number0/iroh-win32-arm64-msvc` | 原生支持 | 已内置映射与 `sha512` 校验 |
| **macOS Apple Silicon** (`darwin-arm64`) | `@number0/iroh-darwin-arm64` | 原生支持 | **完整验证**（Apple Silicon macOS 26.6.2，`bun test` 57/57 通过） |
| **macOS Intel** (`darwin-x64`) | 不支持（上游未发布该架构包，UI 自动引导切换） | 原生支持 | 模式 2 / 3 完整可用 |
| **Linux x64 (glibc / musl)** | `@number0/iroh-linux-x64-gnu` / `-musl` | 原生支持 | **完整验证**（Ubuntu 24.04.5 LTS WSL2，`bun test` 57/57 通过） |
| **Linux arm64 (glibc / musl)** | `@number0/iroh-linux-arm64-gnu` / `-musl` | 原生支持 | 已内置映射与 `sha512` 校验 |
| **Linux armv7 (glibc / musl)** | `@number0/iroh-linux-arm-gnueabihf` / `-musl` | 原生支持 | 已内置映射与 `sha512` 校验 |

> **macOS / Linux 路径与权限说明：** 若 `magpie` 不在默认 `PATH` 中，插件会自动探测 `~/.local/bin/magpie`、`/opt/homebrew/bin/magpie`、`/usr/local/bin/magpie`、`/Applications/magpie.app/Contents/MacOS/magpie` 等常见路径，也可通过 `MAGPIE_BIN` 显式指定。在 POSIX 系统上，插件会自动将数据目录权限收紧为 `0700`，私钥文件 `identity.json` 与状态文件 `state.json` 收紧为 `0600`。

<a id="install"></a>

## 安装（magpie 与 npm 说明）

### 在 magpie 中安装（推荐）

1. 打开 magpie → **Plugins** → **Discover** → **Unofficial**（非官方插件）。
2. 找到 **Gruu6y** 发布的 **Simple Share**，点击 **Install**（或通过 CLI 执行 `magpie plugin add @gruu6y/page-simple-share` / `magpie plugin add <本地克隆目录>`）。
3. 从左侧栏打开 **简单分享**（`Simple Share`），进入插件页面；运行 `magpie plugin ls` 应显示 `page  Simple Share (reads providers:list)` 且状态为 `on`。

### 关于 npm 包 `@gruu6y/page-simple-share`

- 本仓库通过标签 `vX.Y.Z` 自动发布至 npm：[`@gruu6y/page-simple-share`](https://www.npmjs.com/package/@gruu6y/page-simple-share)（[版本历史 / Tags](https://github.com/Gruu6y/magpie-simple-share/tags)）。
- **面向普通用户**：这是 magpie 安装插件时拉取的分发包，**不需要**自己手动 `npm install`。
- **面向脚本与 Agent**：安装进 magpie 后（或从源码克隆），插件目录里自带零依赖 CLI（`bin/simple-share.mjs`），在 Windows / macOS / Linux 下均已设置可执行权限，无需额外装包即可直接驱动本地服务（详见 [Agent 与命令行接口](#cli)）。

<a id="quick-start"></a>

## 快速开始

双方装好插件后，走完下面几步通常只需 2 分钟。

### 宿主端（我想把模型分享给家人或朋友）

#### 第 1 步：确认连接模式与开启分享

1. 打开 magpie 左侧栏 **简单分享**，默认处于 **「我分享出去的」** 页。
2. 如使用默认 **模式 1（P2P）**，可先切到 **「连接与安全」** 点击 **下载并校验 P2P 组件**（从国内镜像拉取 `@number0/iroh@1.2.0` 并校验 `sha512`）；若已有国内 VPS 或公网 IPv6，可直接切到 **模式 2** 或 **模式 3**（免下载）。
3. 打开顶部对外分享开关；首次开启会弹出使用条款与隐私知情确认框，确认后宿主开始监听加密通道。

#### 第 2 步：生成一次性分享邀请（支持离线 `.html` 邀请卡与在线邀请链接）

点击 **「＋ 生成分享邀请」**，可根据亲友是否已装好软件选择有效期：**5 分钟（默认）**、**30 分钟（推荐新亲友首次安装）** 或 **2 小时**，然后任选一种方式发送给对方：

- **导出离线邀请卡（`.html`）**（推荐微信电脑端发文件）：单文件自包含、零外部 CDN/字体、无需服务器与梯子，对方直接双击即可查看宿主指纹、4 条安全透明声明、国内无梯子安装引导与一键唤起本机插件按钮。
- **在线邀请链接**（`https://.../join/#mshare1:...`）：模式 2 自建盲中转会自动提供 `/join/#mshare1:...` 链接；也可在 **「连接与安全」** 中可选配置自定义的国内直连静态托管页地址（仓库已预渲染 [docs/join/index.html](docs/join/index.html)）。**`#mshare1:...` 锚点仅在浏览器客户端解析，绝不通过 HTTP 发往任何服务器。**
- **原始 `mshare1:...` 邀请码 / 离线 SVG 二维码**：适合对方已装好插件时直接粘贴。

几个值得留意的细节：

- 邀请码**不含任何 API Key 或 `gateway-key`**，仅包含宿主公钥、模式连接点与一次性随机令牌。
- 邀请码**单次有效**，连续输错 **5 次** 会自动作废；未用完前也可随时在界面手动撤回或切换有效期重新生成（旧邀请会自动作废）。

#### 第 3 步：核对 4 位配对码并审批额度

对方提交申请后，**「待处理申请」** 区域会出现其设备昵称、Ed25519 公钥指纹与 **4 位安全配对码（SAS）**：

1. 通过微信等原先发码的渠道与对方口头/文字核对这 4 位数字完全一致。
2. 勾选开放给对方的模型（界面清晰标注 API 供应商/路由组与个人订阅账号），设定周期（每日/每周/每月等）、Token 上限（万）、费用上限与最大并发数，点击 **「同意分享」**。
3. 同意后，插件自动在宿主本机创建受限的 `magpie gateway-key`（强制 `mcp none`、`memory off`、`admin off`，默认 `quotas off`）。

#### 第 4 步：随时调整、暂停或一键断流

在 **「已分享的人」** 列表中，可按 **近 7 天 / 本月 / 全部** 查看用量统计，点击成员行展开按模型明细，随时修改可用模型与额度、**暂停 / 恢复**（暂停期间保留额度，对端调用返回 `403 share_paused`），或 **撤销删除**（立刻掐断进行中的流式响应并销毁对应 `gateway-key`）。

---

### 接收端（我想使用别人分享给我的模型）

#### 首次安装引导（国内无梯子友好）

若接收端尚未安装 `magpie` 或本插件，直接打开宿主发来的**离线 `.html` 邀请卡**或**在线邀请链接**即可按系统（Windows / macOS / Linux）获取一行式引导命令与手动备选步骤，也可直接运行仓库自带的幂等引导脚本：

```powershell
# Windows (PowerShell)：默认使用 https://registry.npmmirror.com，下载强校验 SHA256
pwsh -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -Invite "https://.../join/#mshare1:..."
```

```sh
# macOS / Linux (POSIX sh)：不向任何远端服务器上传邀请码，支持 --mirror / --apply / --dry-run
sh scripts/bootstrap.sh --invite "https://.../join/#mshare1:..."
```

引导脚本会自动检测/校验安装 `magpie`（支持 `--mirror` 或 `MAGPIE_DOWNLOAD_MIRROR`，严格执行 SHA256 校验并在受限网络下给出中文手动指引）、通过国内镜像 `https://registry.npmmirror.com` 安装 `@gruu6y/page-simple-share`、在模式 1 下按需准备好 Iroh 组件，最后打开本机 `http://127.0.0.1:3494/#invite=...`（或传 `--apply` 直接在终端提交并打印 4 位配对码）。

#### 第 1 步：打开本地交接链接或粘贴邀请码/链接

1. **自动本地交接**：从离线邀请卡、`/join` 落地页或引导脚本点击打开 `http://127.0.0.1:3494/#invite=mshare1:...` 时，插件会**立即从地址栏清除 `#invite=` 锚点**（避免留在浏览器历史中），自动切到 **「分享给我的」** 并打开邀请确认第 2 步——展示宿主名称、传输模式、Ed25519 公钥指纹与 4 条安全透明声明，**绝不在未经你本人点击确认前自动提交申请（彻底杜绝 CSRF）**。
2. **手动粘贴**：也可打开 **简单分享** → **「分享给我的」** → **「输入分享邀请…」**，直接粘贴 `mshare1:...` 原始码或完整邀请链接（`https://.../#mshare1:...`），点击 **「解析邀请」**，核对指纹并填写设备昵称后提交申请。

#### 第 2 步：告知 4 位配对码等待审批

提交后页面大号展示 **4 位安全配对码（SAS）**。告知对方核对一致并同意后，插件会自动：

- 在本机回环启动独立加密桥接端口；
- 调用 `magpie provider add` 自动添加 `remote-magpie` 供应商（`mshare-<宿主名>-<短ID>`）；
- 等待并确认本机 magpie 网关加载完新模型列表，本机所有已接入 magpie 的 Agent 直接可用。

#### 第 3 步：一键测试端到端流式链路

在 **「分享给我的」** 卡片上点击 **「测试连接与流式输出」**，可实时验证链路类型（直连 / 中转）、端到端往返延迟（RTT）与真实流式返回；不用时点击退出会自动卸载对应 `remote-magpie` 供应商并关闭本地桥接。

<a id="tabs"></a>

## 核心页面一览

| 页面 | 用途与核心能力 |
| --- | --- |
| **我分享出去的** | 总开关与首次使用条款确认、宿主昵称修改、本机网关状态提示、生成/撤回一次性邀请（支持可选有效期 5 分钟 / 30 分钟 / 2 小时、离线 `.html` 邀请卡导出、在线邀请链接复制与离线 SVG 二维码）、**待处理申请** SAS 核对与模型/周期/额度/并发审批、**已分享的人**多时间段用量明细（近 7 天 / 本月 / 全部）与编辑/暂停/立即撤销断流、**分享可见内容**隐私开关（是否可见自身限额 `/v1/magpie/limit`、是否可见宿主全局余量 `quotas`）。 |
| **分享给我的** | 解析并申请加入 `mshare1:...` 原始邀请码或完整邀请链接、支持 `#invite=mshare1:...` 本地自动交接（立即清除 URL 锚点、仅打开第 2 步人工确认页绝不自动提交）、申请等待态大号 4 位 SAS 展示与撤回、已加入分享卡片（展示宿主名、连接状态、可用模型与限额进度）、一键 **测试连接与流式输出** 与退出清理。 |
| **连接与安全** | 三种异地互通模式切换与草稿编辑、模式 1 `@number0/iroh` 按需镜像下载与自定义私有 Relay、模式 2 自建盲中转地址/口令配置与一键连通性测试、模式 3 公网地址/端口配置与公网 IPv6/端口可达性检测、可选的 **在线邀请页地址（`shareBaseUrl`）** 国内静态托管配置、本机 Ed25519 公钥指纹 / Iroh EndpointId 展示与 **6 项绝对安全自检**。 |

![简单分享的「分享给我的」页面：实时直连状态、每日额度进度条、可用模型与一键测试连接](assets/screenshot-received.png)

![简单分享的「连接与安全」页面：三种异地互通模式、按需 P2P 组件校验、密码学身份指纹与 6 项绝对安全自检](assets/screenshot-network.png)

<a id="modes"></a>

## 三种异地互通模式与盲中转部署

在 **「连接与安全」** 标签页可随时切换，且选定模式 2 或模式 3 后**严禁自动回落第三方公共节点**：

| 模式 | 适用场景 | 底层机制 | 额外二进制 |
| --- | --- | --- | --- |
| **模式 1 · P2P 打洞直连 + 盲中转兜底**（默认） | 普通家庭宽带、无公网 IP、不想折腾服务器 | `@number0/iroh@1.2.0`（QUIC 点对点打洞直连，双对称 NAT 下经盲中转端到端密文转发；支持填自定义私有 `iroh-relay`） | 按需从国内镜像下载并校验 `sha512` |
| **模式 2 · 用户自建极简盲中转** | 已有国内轻量云 / VPS，追求极致稳定 | 纯 Bun 内置 TLS 1.3 mTLS 跑在内层 + 单文件盲转发器（支持直接填 `IP:端口` 免域名备案，或 `wss://.../ws`） | **零额外原生二进制** |
| **模式 3 · 公网 IPv6 / IPv4 直连** | 宿主具备公网 IPv6/IPv4 且可放行入站端口，追求零第三方元数据 | 纯 Bun 内置 TLS 1.3 mTLS（双向钉死 Ed25519 公钥，支持 DDNS 动态域名，免申请 HTTPS 证书） | **零额外原生二进制** |

### 模式 2：部署极简盲转发器

盲转发器源码位于 [relay/simple-share-relay.mjs](relay/simple-share-relay.mjs) 与 [relay/Dockerfile](relay/Dockerfile)，由本仓库 CI 自动构建多架构（`linux/amd64` / `linux/arm64`）镜像并推送至 `ghcr.io/gruu6y/magpie-simple-share-relay:latest`。服务器仅按匿名 `slotId` 透传 TCP / WebSocket 密文字节流，**不终止内层 TLS、不保存任何密钥与成员信息**，并提供 `GET /health` 健康检查、`/ws` 升级路径，以及内置零外链的 **`GET /join`（`/join/`）静态邀请落地页**（返回严格 CSP 与 `Cache-Control: no-store`，纯客户端解析 `#mshare1:...` 锚点，独立 Docker 构建也完整可用）：

```bash
# 方式 A：一条 Docker 命令直接拉取官方多架构镜像运行
docker run -d --name simple-share-relay --restart=always \
  -p 3499:3499 \
  -e PORT=3499 \
  -e RELAY_TOKEN=你的防蹭网口令 \
  ghcr.io/gruu6y/magpie-simple-share-relay:latest

# 方式 B：在 VPS 上直接用 Bun 运行单文件
PORT=3499 RELAY_TOKEN=你的防蹭网口令 bun relay/simple-share-relay.mjs

# 方式 C：从源码本地构建镜像
docker build -t simple-share-relay ./relay
```

部署完成后，在 **「连接与安全」→ 模式 2** 填入 `你的服务器IP:3499`（若套了反向代理则填 `wss://你的域名/ws`）及相同口令，点 **测试盲中转连通性** 验证 TCP/WS 畅通后保存启用即可。

<a id="features"></a>

## 核心功能与零信任安全机制

### 密码学与传输层零信任

- **统一身份与双向公钥钉死**：首次启动自动生成本机 Ed25519 密钥对（同时派生自签名 mTLS 证书与一致的 Iroh `EndpointId`）。无论走模式 1、2 还是 3，均在加密握手层双向校验对方 Ed25519 公钥，**不信任任何系统 CA 或第三方 CA**；未批准的公钥在握手层直接拒绝，0 字节触达应用层。
- **盲中转零明文暴露**：模式 2 中转服务器只转发匿名 `slotId` 关联的密文字节流；即便在链路中间抓包，也看不到任何提示词、请求路径、模型名或 API 密钥。
- **严格禁止偷偷回落**：选定模式 2 或模式 3 后，如果自建中转或公网端口不可达，直接报错提示，绝不悄悄切去第三方公共中继。

### 宿主网关隔离与实时止损

- **严格路径白名单**：宿主转发器仅放行：
  - `GET`：`/v1/models`、`/models`、`/v1/magpie/limit`（以及宿主显式开启可见性后的 `/v1/magpie/quotas`）
  - `POST`：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1beta/models/<model>:generateContent`、`/v1beta/models/<model>:streamGenerateContent`
  - 彻底拦截 `/v1/magpie/admin/*`、`/v1/magpie/native/*`、`/v1/magpie/keys*`、`/v1/magpie/memory*`、`/mcp*`，以及路径穿越、编码斜杠、反斜杠与双斜杠。
- **1ms Fail-Closed 验活**：每次向本机 `127.0.0.1` magpie 网关转发推理请求前，先用该成员专属 `gateway-key` 请求本机 `/v1/magpie/limit`；若本机密钥已被手工删除或返回异常，立即拒绝请求，绝不放行未受控的匿名调用。
- **请求头净化与精细可见性**：转发前剥离对端传入的 `authorization`、`x-api-key`、`x-goog-api-key`、`cookie`、`x-forwarded-for`、`host` 等敏感头，仅在宿主回环侧注入成员专属 `gateway-key`。默认关闭 `quotas` 透传，不暴露宿主全局账号余量。
- **撤销即刻断流**：撤销成员时同步中止该成员所有活跃 SSE 流、立即驱逐加密通道并调用 `magpie gateway-key remove` 销毁本机密钥，同时不影响其他已授权成员的正常推理。

### 沙盒前端与控制面隔离

- **仅监听本机回环**：本地控制面 HTTP 服务与接收端本地桥接均绑定 `127.0.0.1`，拒绝非回环 `Host` / `Origin` 访问，且所有 `/api/*` 路由强制校验每次启动随机生成的 `x-simple-share-token`。
- **零外链离线 UI**：前端代码零外部 CDN、零 `localStorage`/`sessionStorage`、内置离线 SVG 二维码生成，适配 magpie 沙箱 iframe 并自动跟随宿主深浅色主题。

<a id="cli"></a>

## Agent 与命令行接口（CLI / HTTP API）

**不想点页面？直接用命令行或让 AI Agent 驱动简单分享。** 插件自带零依赖 CLI（[bin/simple-share.mjs](bin/simple-share.mjs)）和本地回环 HTTP 接口，方便脚本化运维、巡检与自动化测试。

### 给 Agent 的 3 步快速接入

1. **直接运行 CLI（无需安装额外依赖）**：
   - 源码或插件目录内：`bun bin/simple-share.mjs <命令>`（在 macOS / Linux 下也可直接 `./bin/simple-share.mjs <命令>`）
   - 若已通过包可执行入口加入 `PATH`：`magpie-simple-share <命令>` 或 `simple-share <命令>`
2. **一步获取全量诊断与状态**：运行 `doctor --json`（无论服务是否运行，均可输出控制面状态、本机指纹、Magpie 网关发现结果、`iroh` 安装/完整性状态与安全项自检）或 `status --json`。
3. **离线读状态，在线做变更**：服务未启动时，`doctor`、`status`、`members`、`pending`、`received` 与无参数 `mode` 仍可直接读取脱敏后的本地存储；写操作（开关分享、发邀请、审批、暂停/撤销、加入分享、切模式）需要本地控制面在线。

### 连接、鉴权与输出契约

- **默认地址**：`http://127.0.0.1:3494`（可用 `--port <n>`、环境变量 `SIMPLE_SHARE_PORT` 或 `--url <http://127.0.0.1:...>` 覆盖；**`--url` 强制校验仅允许本机回环地址**，拒绝连接非回环远端地址）。
- **自动鉴权**：CLI 访问本机控制面时，自动从 `/` 页面的 `<meta name="simple-share-token">` 读取当次进程随机 token 并通过请求头 `x-simple-share-token` 发送（也支持 `--token <HEX>` 显式传入），**绝不在输出中打印 token**。
- **机器可读输出**：加 `--json` 时，成功输出合法 JSON 到 stdout（退出码 `0`）；失败输出单行 JSON `{"error":"...","code":"...","message":"..."}` 到 stderr（退出码 `1`）。

### 完整 CLI 命令速查表

| 分类 | 命令 | 说明 |
| --- | --- | --- |
| **自检与总览** | `doctor [--json]` | 本地环境、身份指纹、Magpie 网关、`iroh` 状态与安全项全量自检 |
| | `status [--json]` | 查看插件状态（在线查控制面，离线读脱敏本地存储） |
| **宿主开关与邀请** | `toggle <on\|off> [--tos]` | 开启或关闭对外分享（首次开启需传 `--tos` 确认条款） |
| | `invite [--ttl <秒>] [--card [out.html]]` / `invite revoke <inviteId>` | 生成一次性邀请码与分享链接（`--ttl` 支持 `60..86400` 秒，默认 `300`；`--card` 导出离线 `.html` 邀请卡）/ 作废指定邀请 |
| **审批与成员管理** | `pending` | 列出待审批申请及 4 位配对码（SAS） |
| | `approve <pendingId> [--models m1,m2] [--period day] [--tokens 100] [--cost 3] [--concurrency 2] [--note 备注]` | 审批申请并自动创建受限 `gateway-key`（`--tokens` 单位为万） |
| | `reject <pendingId>` | 拒绝申请并作废对应邀请 |
| | `members` | 列出已分享成员、状态、活跃流数与对应 `gateway-key` 名称 |
| | `pause <memberId>` / `resume <memberId>` | 暂停（返回 `403 share_paused`）或恢复成员 |
| | `revoke <memberId>` | 撤销成员、立即断流并销毁本机 `gateway-key` |
| **接收端操作** | `apply <code-or-url> [--name <设备名>]` | 提交 `mshare1:...` 邀请码或完整邀请链接并打印 4 位配对码（SAS） |
| | `join <inviteCodeOrUrl> [--name <设备名>]` | 一键加入：解析邀请，模式 1 按需自动安装 Iroh 组件，提交申请并醒目打印 4 位 SAS（支持 `--json`） |
| | `received` / `received test <shareId> [--model <m>]` / `received leave <shareId>` | 查看已加入分享 / 测试端到端连接与流式输出 / 退出并移除 `remote-magpie` |
| **网络模式** | `mode [p2p\|self-relay\|direct]` | 查看或切换传输模式；可配 `--iroh-relay`、`--relay`、`--relay-token`、`--share-base-url`、`--host`、`--direct-port` |

### 常用命令示例

```sh
# 1) 一步体检与查状态（推荐 Agent 首条命令）
bun bin/simple-share.mjs doctor --json
bun bin/simple-share.mjs status --json

# 2) 宿主端：首次开启分享、生成 30 分钟邀请并导出离线 .html 邀请卡、查看并审批申请
bun bin/simple-share.mjs toggle on --tos
bun bin/simple-share.mjs invite --ttl 1800 --card invite-card.html --json
bun bin/simple-share.mjs pending --json
bun bin/simple-share.mjs approve <pendingId> --models openai/gpt-5,deepseek/deepseek-chat --period day --tokens 100 --cost 3 --concurrency 2 --note 家人笔记本

# 3) 宿主端：暂停、恢复或撤销成员（撤销立即断流）
bun bin/simple-share.mjs members --json
bun bin/simple-share.mjs pause <memberId>
bun bin/simple-share.mjs resume <memberId>
bun bin/simple-share.mjs revoke <memberId>

# 4) 接收端：用完整邀请链接一键加入（模式 1 自动装 Iroh）、测试连通性或退出分享
bun bin/simple-share.mjs join "https://你的国内域名/join/#mshare1:..." --name 我的电脑
bun bin/simple-share.mjs apply "mshare1:..." --name 我的电脑
bun bin/simple-share.mjs received --json
bun bin/simple-share.mjs received test <shareId> --json
bun bin/simple-share.mjs received leave <shareId>

# 5) 切换传输模式（模式 2 自建盲中转 / 模式 3 公网直连，可选配置在线邀请页基础地址）
bun bin/simple-share.mjs mode self-relay --relay 203.0.113.10:3499 --relay-token 你的口令
bun bin/simple-share.mjs mode direct --host home.example.com --direct-port 3497 --share-base-url https://share.example.cn/join
```

### 直接调用 HTTP API（给无 Shell 的 Agent）

除 `GET /api/health` 外，所有 `/api/*` 路由均要求请求头 `x-simple-share-token: <token>` 且仅接受本机回环请求：

- **健康与全量状态**：`GET /api/health`、`GET /api/state`
- **宿主控制**：
  - `POST /api/host/toggle`、`POST /api/host/name`、`POST /api/host/visibility`、`POST /api/host/share-base-url`（配置可选在线邀请页基础地址 `{ shareBaseUrl }`）
  - `POST /api/host/invites`（可选 `{ ttlSec }`，返回含 `shareUrl`、`cardFilename`）、`GET /api/host/invites/:id/card`（默认返回 `{ ok, id, filename, html }`，加 `?raw=1` 直接返回带 `Content-Disposition: attachment` 与 `Cache-Control: no-store` 的离线 HTML）、`DELETE /api/host/invites/:id`
  - `POST /api/host/pending/:id/approve`、`POST /api/host/pending/:id/reject`
  - `POST /api/host/members/:id/pause`、`PATCH /api/host/members/:id`、`DELETE /api/host/members/:id`
  - `GET /api/host/usage?range=7d|month|all`
- **接收端操作**：
  - `POST /api/receiver/parse`（支持原始码与完整邀请链接）、`POST /api/receiver/apply`、`DELETE /api/receiver/pending/:id`
  - `POST /api/receiver/shares/:id/test`、`DELETE /api/receiver/shares/:id`
- **传输网络配置与探测**：
  - `POST /api/network/mode`（可选携带 `network.shareBaseUrl`）、`POST /api/network/iroh/install`
  - `POST /api/network/test-relay`、`POST /api/network/test-direct`
- **模式 2 盲中转服务端**（`relay/simple-share-relay.mjs`）：
  - `GET /health`、`GET /join` / `GET /join/`（零外链静态邀请落地页，严格 CSP + `Cache-Control: no-store`，仅客户端解析 `#mshare1:...`）、`WS /ws`

完整 CLI 帮助请运行 `bun bin/simple-share.mjs --help`。

<a id="troubleshooting"></a>

## 排查问题

| 现象 | 怎么办 |
| --- | --- |
| 首次执行 `toggle on` 或开启分享报错 `tos_required` | 首次开启必须确认使用条款与隐私说明：页面中勾选确认弹窗，或在 CLI 中传入 `toggle on --tos`。 |
| 邀请码无法解析、提示过期或失效 | `mshare1:...` 邀请码默认 **5 分钟过期**（首次安装可在生成弹窗改选 **30 分钟** 或 **2 小时**，或通过 `--ttl 1800` 生成）、仅限 **1 次使用**，且连续输错 **5 次** 会自动烧毁作废；请宿主重新点 **生成分享邀请**。 |
| Intel Mac 上模式 1 提示不支持 | 上游 `@number0/iroh@1.2.0` 未发布 `darwin-x64` 原生组件。切到 **模式 2（自建盲中转）** 或 **模式 3（公网直连）** 即可，无需任何额外原生二进制。 |
| 模式 1 组件下载失败或提示校验失败 | 下载器优先走国内镜像 `https://registry.npmmirror.com` 并在失败或哈希不匹配时自动回退 `https://registry.npmjs.org`，解包前强制校验固定 `sha512`。检查网络后重试，或直接改用零额外二进制的模式 2 / 3。 |
| 选了模式 2 / 模式 3 后连不上，为什么没自动走 P2P | **刻意设计，非故障。** 选定模式 2 或 3 后严禁偷偷回落第三方公共节点，以免违背用户的隐私预期。请用 **测试盲中转连通性** 或 **检测公网端口可达性** 排查 VPS 防火墙 / 端口映射与 `RELAY_TOKEN`。 |
| 接收端调用返回 `403 share_paused` | 宿主已将该成员设为「暂停」（配额与配置均保留）；联系宿主点击 **恢复分享** 即可继续使用。 |
| 接收端调用报网关/限额校验失败 | 若宿主本机 magpie 网关离线，或对应成员的 `gateway-key` 被手动删除，宿主会触发 **Fail-Closed 拦截** 拒绝放行。确认宿主 `magpie` 正常运行；若密钥已被手删，建议宿主撤销后重新邀请成员。 |
| 提示找不到 `magpie` 命令或网关离线 | 运行 `bun bin/simple-share.mjs doctor --json` 检查探测到的 `magpieGateway`；若 `magpie` 安装在非标准路径，设置 `MAGPIE_BIN=/path/to/magpie` 后重试。 |
| 端口 `3494` 被占用 | 在 magpie 插件选项中修改 `port`，并在运行 CLI 时传对应 `--port <n>` 或设置 `SIMPLE_SHARE_PORT`。 |

<a id="privacy"></a>

## 隐私、数据目录与环境变量

- **零遥测、零正文日志**：插件不采集任何遥测数据，用量统计仅提取 token 数与本地单价估算，**绝不记录提示词与回复正文**。
- **数据存放位置**：
  - 默认全部存于 `~/.config/magpie/magpie-simple-share/`（受 `MAGPIE_CONFIG_DIR` / `XDG_CONFIG_HOME` 影响）：
    - `identity.json`：本机 Ed25519 私钥与证书材料（POSIX 强制 `0600`）
    - `state.json`：分享设置、成员台账、接收端配置与 token 统计事件（POSIX 强制 `0600`）
    - `iroh/`：模式 1 按需下载的 `@number0/iroh@1.2.0` 原生组件与 `manifest.json`
  - 宿主侧通过 `magpie gateway-key` 写入受限密钥；接收端通过 `magpie provider add` 写入 `remote-magpie` 供应商配置。
- **接口脱敏**：所有状态查询 API 与 CLI 输出均经过 `sanitizeStateSnapshot` 脱敏，不返回私钥、邀请密钥、`bridgeToken` 与 `magpieKeySecret`。

### 环境变量一览

| 环境变量 | 适用端 | 用途 |
| --- | --- | --- |
| `MAGPIE_CONFIG_DIR` | 插件 & CLI | 覆盖 magpie 配置根目录（优先级最高，其次 `XDG_CONFIG_HOME/magpie`，默认 `~/.config/magpie`） |
| `MAGPIE_SIMPLE_SHARE_DATA` / `MAGPIE_SIMPLE_SHARE_DATA_DIR` | 插件 & CLI | 覆盖本插件数据目录（默认 `<MAGPIE_CONFIG_DIR>/magpie-simple-share`） |
| `SIMPLE_SHARE_PORT` | CLI | 覆盖默认控制面端口（默认 `3494`） |
| `MAGPIE_BIN` / `SIMPLE_SHARE_MAGPIE_BIN` / `MAGPIE_CLI` | 插件 & CLI | 显式指定 `magpie` 可执行文件路径（会自动忽略安装脚本常用的布尔值如 `MAGPIE_CLI=1`） |
| `MAGPIE_ADDR` | 插件 & CLI | 覆盖本机 magpie 网关回环地址（默认自动读取 `gateway.json` / `magpie status --json`） |
| `MAGPIE_DOWNLOAD_MIRROR` | 引导脚本 | 为 [scripts/bootstrap.ps1](scripts/bootstrap.ps1) / [scripts/bootstrap.sh](scripts/bootstrap.sh) 指定 Magpie 安装包国内镜像基址（仍强制执行 SHA256 校验） |
| `HOST` / `PORT` / `RELAY_TOKEN` | 模式 2 盲中转服务端 | 配置 [relay/simple-share-relay.mjs](relay/simple-share-relay.mjs) 监听地址（默认 `0.0.0.0`）、端口（默认 `3499`）与防蹭网口令 |

<a id="contributing"></a>

## 参与贡献

欢迎审计代码、打开 Issue 与提交 Pull Request。本仓库以完整自动化测试套件为契约：

```bash
bun test
```

提交改动前请确保测试套件通过：无本地 `magpie` / 无头浏览器时会自动跳过外部二进制端到端用例并运行全部核心安全与协议单测；在安装了 `magpie` 与 `playwright-core` 的环境下可传 `REQUIRE_MAGPIE_E2E=1 REQUIRE_BROWSER_TESTS=1` 运行全部 8 个测试文件 / 57 个用例。重新生成 README 脱敏截图可使用 [scripts/shoot-readme-screenshots.mjs](scripts/shoot-readme-screenshots.mjs)。完整协议设计、安全边界与架构细节请参阅 [docs/architecture.md](docs/architecture.md)。

<a id="license"></a>

## 许可

[MIT](LICENSE) © 2026 Gruu6y · 架构与安全设计见 [docs/architecture.md](docs/architecture.md)
