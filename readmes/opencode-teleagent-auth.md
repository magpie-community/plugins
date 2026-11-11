<p align="center">
  <a href="https://github.com/anbulang/opencode-teleagent-auth/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/anbulang/opencode-teleagent-auth?label=release&color=2ea44f"></a>
  <a href="https://www.npmjs.com/package/opencode-teleagent-auth"><img alt="npm" src="https://img.shields.io/npm/v/opencode-teleagent-auth?label=npm&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-purple"></a>
  <a href="https://github.com/anbulang/opencode-teleagent-auth"><img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey"></a>
  <a href="https://github.com/anbulang/opencode-teleagent-auth"><img alt="magpie" src="https://img.shields.io/badge/magpie-0.1.684%2B-orange"></a>
  <a href="https://github.com/anbulang/opencode-teleagent-auth"><img alt="tests" src="https://img.shields.io/badge/tests-146%20passing-brightgreen"></a>
  <a href="https://github.com/anbulang/opencode-teleagent-auth/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/anbulang/opencode-teleagent-auth?style=social"></a>
</p>

<h1 align="center">opencode-teleagent-auth</h1>

<p align="center">
  把本机登录的 <b>TeleAgent</b>（天翼 AI 星辰超级智能体桌面端）的 5 个模型接进 <b>magpie</b>（OpenCode）。
  <br>
  复用桌面端已有登录态，<b>不需要注册新账号、不需要 API key</b>。
</p>

> 仓库与 npm 包同名，都是 `opencode-teleagent-auth`。插件在 magpie 里的显示名是 **TeleAgent 模型**，
> 供应商 id 是 `teleagent`，模型写作 `teleagent/chat-pro`。

---

## ✨ 特性

- **5 个官方模型**：智能 / 旗舰 / 极速 / 轻量 / 轻速，上下文 400K / 100K，带图片输入与积分倍率
- **无 API key 登录**：读本机 TeleAgent 登录态（macOS 钥匙串 / Windows DPAPI），点一下「读取本机登录态」
- **请求现场签名**：每请求现读 token、现签两步 HMAC，带设备指纹，与桌面端内核一致
- **OpenAI 兼容**：真流式、多轮、工具调用、`reasoning_content` 思维链原样交给 magpie
- **积分与签到**：`magpie quota` 看余额与套餐；每日签到幂等，失败不影响模型
- **只读工具 `points`**：agent 能自己回答「我还有多少积分」，不花积分、不发模型请求
- **多账号**：本机多个登录态映射成多个账号，并发与熔断按账号隔离
- **防突发**：并发 2 / 每分钟 20 次 / 连续 3 次 401·403 熔断 10 分钟
- **隐私**：不写请求日志、不上报账号信息，出站只有 `agent.teleai.com.cn`

## 模型

| modelID | 名称 | 上下文 | 输出 | 图片 | 积分倍率 |
|---|---|---|---|---|---|
| `chat-pro` | 智能 | 400K | 65536 | ✅ | x0.6 |
| `chat-flagship` | 旗舰 | 400K | 65536 | ❌ | x1.0 |
| `chat-flash` | 极速 | 400K | 65536 | ✅ | x0.2 |
| `chat-lite` | 轻量 | 100K | 16384 | ❌ | x0.5 |
| `chat-nano` | 轻速 | 100K | 16384 | ❌ | x0.1 |

在 magpie 里显示为 `智能 · x0.6`，倍率来自 TeleAgent 自己的模型目录。倍率是积分消耗倍率，
**不是折扣**；输出上限前三个是 65536，`chat-lite` / `chat-nano` 是 16384。

图片支持是实测结论，不是上游目录的声明：`chat-lite` 会给 200 但答非所问，`chat-nano` 报
`is not a multimodal model`，`chat-flagship` 报 `1210`，所以都按「不支持」声明。

## 前置条件

1. macOS 或 Windows（0.2.0 起支持 Windows；Linux 尚未适配）
2. TeleAgent 桌面端 **2.7.1 或更高版本**，已安装并**登录**，与 magpie 使用同一个操作系统用户
3. magpie **0.1.684+**（`magpie --version`）；更早的版本模型能用，但积分与签到不跑
4. macOS 首次读取时允许钥匙串授权；Windows 使用系统自带的 Windows PowerShell 和 DPAPI

**不需要**：magpie 账号之外不用注册、不用申请 API key、不用手动复制 token、不用 root。

> 桌面端不必一直开着，但**登录态要存在**——插件读的是磁盘凭据，不是运行中的进程。

插件从安装包读取实际版本。版本低于 2.7.1 或无法读取时，插件会拦截账号接入、模型调用、积分查询和签到。

Windows 数据目录是 `%USERPROFILE%\.local\share\TeleAgent`。安装资源会从用户的
`AppData\Local\Programs\TeleAgent`、系统的 `Program Files\TeleAgent` 等位置查找。
如果安装在其他位置，可在启动 magpie 的同一个 PowerShell 中指定：

```powershell
$env:TELEAGENT_APP_PATH = 'D:\Apps\TeleAgent'
magpie plugin login teleagent
```

`TELEAGENT_APP_PATH` 也可指向 `TeleAgent.exe`、`resources` 或 `app.asar`。
自定义数据/配置目录使用 `TELEAGENT_DATA` / `TELEAGENT_CONFIG`。
magpie 自带 Bun，无需另外安装 sqlite3；直接用 Node 时建议 Node 22.13+ 或 24，
旧 Node 的积分查询仍需要 `sqlite3` 命令。Windows 凭据不能复制到另一系统用户下使用。

## 安装

### 方式 A：npm（推荐）

```bash
magpie plugin add opencode-teleagent-auth
```

### 方式 B：git 仓库

```bash
magpie plugin add github:anbulang/opencode-teleagent-auth
magpie plugin add github:anbulang/opencode-teleagent-auth#v0.1.0   # 钉版本
```

### 方式 C：本地目录（开发用）

```bash
magpie plugin add /path/to/opencode-teleagent-auth
```

界面里也能装：**插件** → **发现** / **添加插件** → 粘贴包名、git 地址或本地路径。

三种装法内容是同一份代码。插件短名由包名推导：剥掉 `opencode-` 前缀与 `-auth` 后缀得
`teleagent`，所以工具全名是 `teleagent_points`、MCP 短名是 `teleagent`。按本地目录装时目录名
若不同，工具全名会跟着变（目录名 `opencode-teleagent-auth` 则仍是 `teleagent_points`）。

### 装好了怎么确认

```bash
magpie plugin            # 列表里应有「TeleAgent 模型」
magpie plugin --json     # 机器可读；只读清单，不联网、不花积分
```

装完记得**完全退出 magpie 再启动**（别等热更新），并确认没装到别的 profile（`--profile`）。
`magpie provider test teleagent` 会发真实请求、消耗积分，装完不必立刻跑，见「费用与风险」。

### 沙箱安装测试

不想污染自己的 magpie 配置，就开一个隔离 HOME：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
          MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

m plugin add /path/to/opencode-teleagent-auth
m plugin --json
```

隔离 HOME 读不到真实登录态，这是故意的：用来验证「未登录」这条分支干净报错，而不是崩掉或瞎猜。

## 使用

### 登录（一次）

1. 确认桌面端已登录：`ls ~/.local/share/TeleAgent/users/` 下应有 `v1_public_<数字>` 目录
2. 登录：`magpie plugin login teleagent`，或界面里供应商页的「读取本机 TeleAgent 登录态」
3. 在下拉框里选账号；macOS 如有钥匙串弹框，点「允许」或「始终允许」
4. 验证：`magpie quota` 能读到积分余额，说明凭据链路通了

常见失败：`app_missing`（桌面端没装）、`not_signed_in`（桌面端没登录）、
`keychain_denied`（钥匙串点了拒绝，重新登录一次即可）。

> 凭据约 30 天到期，**没有 refresh token**，不能自动续期。到期后桌面端重新登录，
> 再执行一次上面的第 2 步。过期和封禁的报错很像，别等它过期再排查。

### 选模型

在 agent 的模型下拉里选，或直接写：

```text
teleagent/chat-pro       智能 x0.6   日常写代码、长上下文
teleagent/chat-flash     极速 x0.2   便宜、批量
teleagent/chat-flagship  旗舰 x1.0   短问答（不看图）
teleagent/chat-lite      轻量 x0.5   不太推荐（比 flash 贵却更弱）
teleagent/chat-nano      轻速 x0.1   极短、极便宜
```

要发图片就用 `chat-pro` / `chat-flash`。

### 积分与签到

- 供应商页卡片 / 用量页显示积分余额、最早过期时间、套餐名，对应 `magpie quota`
- 积分是**预付钱包式余额**，没有「已用 / 上限」，所以不参与额度耗尽判断
- 每日签到默认关：设置 → 用量 → 插件 tab → TeleAgent → 「每日签到」；也可以手动领
- 签到是唯一会改服务器状态的积分操作：先查 `claimed_today`，已领就短路返回 `done`，
  领完再查一次，失败不重试
- 积分和聊天是两个服务：读不到积分不影响模型，两边独立降级

签到接口序列：

```text
GET  /companyStore/v2/checkDayTask              → 今天领没领、能领多少
POST /companyStore/checkTask?type=daily_login   → 领取
GET  /companyStore/v2/checkDayTask              → 再确认一次
```

积分 cookie 来自桌面端每个账号的 Chromium 分区
`~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Cookies`，插件只读
`operationToken`（也用作 `X-Token` 头）和 `operToken`。读之前会先复制到临时文件，
因为桌面端运行时会锁原库；`no such table: cookies` 属于正常空状态，返回「积分不可用」而不是报错。

> **能读积分 ≠ 账号没被封。** 封的是模型调用通道：`magpie quota` 正常、任意模型都 401，
> 基本就是 `40109`。

### 只读工具 `points`

插件给 agent 挂了一个工具 `points`，全名 `<插件短名>_points`（npm 安装是 `teleagent_points`）。
无参数、无副作用、不消耗积分、不触发领取、不发模型请求，返回余额、到期时间、套餐名、
今日是否已领、可领积分、累计签到天数与积分。

## 多账号

桌面端的数据目录按账号隔离（`~/.local/share/TeleAgent/users/<scope>/`），本机可以同时
存在多个账号的凭据，插件把它们映射成 magpie 的多个账号：

| 概念 | 对应 |
|---|---|
| 本机账号 | `users/<scope>/` 下一个带 `token.json` 的目录 |
| magpie 里的账号 | 一个条目，key 是 `scope`，显示名来自 JWT 的 `accountName` |
| 当前账号 | `current-owner.json` 指向的，或 `token.json` 最新的那个 |

每个账号各自登记一次，**key 只存 `scope`，不存 token**：token 会过期、会被桌面端重新登录
替换，复制进 `plugin-auth.json` 只会变成旧凭据，还多一处泄漏面。登录时下拉框里的选项在
登录那一刻生成，所以刚在桌面端登录了新账号时，重跑一遍 `magpie plugin login teleagent`
就能看到——不需要重启 magpie。

限制：

- 桌面端同一时刻只允许一个「当前登录」，切号要你在桌面端操作；插件不替你换号，
  也不动 `current-owner.json`
- 非当前账号可能没有 portal cookie，表现为「模型能用、积分读不到」
- guard 按账号隔离：一个账号熔断不影响另一个；账号失效后的切换交给 magpie

## 工作原理

插件是 magpie / OpenCode 的供应商插件（`export default async (input) => hooks`），
直连上游的 OpenAI 兼容端点，请求由自己的 `fetch` 现签：

```text
magpie agent
  │  OpenAI 兼容 chat completions
  ▼
magpie 内置 openai-compatible provider
  │  auth.loader 返回的 fetch：现读 token / 现签 ts·nonce / 过 guard
  ▼
https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
```

### 签名

逆向自桌面端内核的 `GatewaySigner.Sign`（lldb 断在 `hmacHex` 入口实测得到两次调用）。
完整推导与踩坑记录见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

第一步，绑定安装标识：

```text
key = JWT 第三段（token.split(".")[2]）
msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
k1  = hex(HMAC-SHA256(key, msg))
```

第二步，签请求指纹：

```text
key = k1（当作 64 字符十六进制文本使用）
msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
sig = hex(HMAC-SHA256(key, msg))
```

两个容易写错的点：`pathname` 必须**包含** `/superCowork/sapi` 前缀；两步顺序反了会得到
`40104 invalid signature`——这说明 token 是对的，只有签名不对。

### 请求头

| 头 | 值 / 来源 |
|---|---|
| `Authorization` | `Bearer <网关 apiKey>`，缺失会 `40105` |
| `X-Token` | 本机解密出的 JWT |
| `X-Superagent-Device-Id` / `-Install-Id` | `device-meta.json` 的 `deviceId` / `installId` |
| `X-Superagent-Timestamp` / `-Nonce` | 每请求新生成的秒级时间戳与 UUID |
| `X-Superagent-Signature` / `-Sign-Version` | 第二步算出的 sig，版本 `v1` |
| `X-App-Version` | 桌面端 `app.asar` 中 `package.json` 的实际版本 |
| `X-Route-Target` | `ops-gateway` |
| `X-Session-Id` / `X-Message-Id` / `x-teleagent-session` | 本地生成的会话标识（opencode 系协议里本就由客户端生成） |

`Authorization` 里那个 apiKey 是**桌面端内置的常量**，作用不是鉴权（真正的鉴权是 JWT +
签名），而是「请求来自官方客户端」的特征之一。插件不硬编码它，运行时按顺序找：插件配置 →
环境变量 `TELEAGENT_API_KEY` → 桌面端 `TeleAgent.jsonc` → 桌面端安装包的 `app.asar`
（只读本地字节，不联网、不解包、不写盘）。四步都失败就发空串，上游回 `40105`，
插件翻译成「本机 TeleAgent 版本不受支持，请更新插件」。

高级选项：`magpie plugin options teleagent '{"verbose":true}'` 会往 magpie 日志写
loader/fetch 阶段信息（不含 token、不含正文）。

### 流式与错误

- magpie 要流式：上游 SSE 字节流原样转发，不重新编码
- magpie 要非流式：插件向上游**仍然发流式**，本地聚合成一条响应——实测桌面端所有请求都是
  `stream: true`，保持这个习惯不在请求形态上露出差异
- `messages` / `tools` 原样送上游，不改 role、不折叠多轮、不注入人格串；工具由 magpie 执行
- 上游业务错误码翻译成人话再报给 magpie，不重试、不吞掉；积分不足、封禁、限流三类
  **不会被自动重试**

### 文件

| 文件 | 职责 |
|---|---|
| `index.mjs` | 插件入口：导出 default 函数，装配 hooks |
| `lib/credential.mjs` | 读 `token.json`、钥匙串解密、凭据诊断、列本机账号 |
| `lib/windows-crypto.mjs` | Windows DPAPI 密钥解锁与 AES-GCM 凭据解密 |
| `lib/installation.mjs` | Windows/macOS 安装路径、ASAR 内容与版本读取 |
| `lib/sign.mjs` | 两步 HMAC、请求头组装、按账号签名的 fetch |
| `lib/guard.mjs` | 并发 / 每分钟 / 熔断 / 空闲回调 |
| `lib/models.mjs` | 5 个模型目录与 `buildModels()` |
| `lib/apikey.mjs` | 网关 apiKey 四级解析 |
| `lib/portal.mjs` | 积分与签到（网络与 sqlite 可注入） |
| `docs/PROTOCOL.md` | 协议笔记：签名 / 凭据 / portal / 封号复盘（本仓库唯一知识来源） |
| `scripts/sandbox.sh` | 隔离 HOME 手测脚本（`--real-home` 才发真实请求） |

## 费用与风险（重要）

上游按 **tokens × 模型积分倍率**计费，输入 tokens **包含完整历史上下文与工具 schema**。
长会话单步很容易到 10 万以上，工具定义也算输入。

省钱建议：

- 长任务用 `chat-flash`（x0.2）或 `chat-pro`（x0.6），`chat-flagship`（x1.0）留给短问答
- 勤开新会话、及时压缩上下文；关掉不用的插件和工具，减少每次请求的 `tools` 数量
- 每天领 100 积分（可查余额；额度不足时上游返回 `402`，插件报「积分不足」而不重试）

### 封号复盘

2026-10-27 两个账号先后因**合成探测**被上游风控封禁，第二个账号大约 1 小时 45 分钟后被封。
触发点是插件自己的探测：5 个模型 × 图片 data URL 逐个试、50–600KB 填充体、10/100/265 个
合成工具名、每次启动发一次真实请求做自检。在风控眼里这是教科书式的自动化流量。

现象是聊天网关返回 `40109 current user is banned`，而**积分接口仍然正常**——封的是模型
调用通道，不是账号。所以「积分还能查，应该没事」是错判。

**不要做**：

- 批量跑 `magpie provider test teleagent`（每个模型一次真实请求，循环跑更快进风控）
- 用 for 循环压测、遍历模型或参数
- 发超大填充体测上限、批量注册合成工具名
- 拿真实账号试签名变体（`40104` 刷屏本身就是异常流量）

**该怎么做**：确认装好用 `magpie plugin --json`（零请求）；确认凭据用 `magpie quota`
（只读、免费）；确认链路只测一个模型一次，然后正常用；看能不能读图用 `chat-pro` 发一张，
别五个模型轮着试。

如果已经被封：停止所有自动化请求 → 确认是不是 `40109` → 换账号（本机多账号会走故障切换）
→ 需要申诉就联系天翼 AI 客服 → 不要改请求头或签名去绕。内置限速只是**降低**被标记的概率，
不保证账号安全。

## 防突发与硬约束

| 机制 | 默认值 | 说明 |
|---|---|---|
| 并发上限 | 2 | 同时最多 2 个上游请求，其余排队 |
| 每分钟上限 | 20 | 超过就等到下一个窗口，不硬闯 |
| 熔断阈值 | 连续 3 次 401/403 | 达到即暂停 10 分钟，期间快速失败 |
| 半开探测 | 1 个 | 冷却结束后只放一个请求试探，成功才恢复 |
| 空闲回调 | 10 分钟 | 最后一次活动后回调一次（当前只记 `verbose` 日志） |

这些数字不是性能参数，是**账号存活参数**，不要为了「跑得快」调大。官方客户端是人工交互，
天然低并发；每分钟 20 次正常对话到不了，能到的只有脚本和压测。guard 按账号隔离。

## 故障排查

排查顺序：从只读往花钱的方向走，别一上来就压测。

```bash
magpie plugin --json            # 1. 插件在不在（零请求）
magpie quota                    # 2. 凭据能不能读（只读、免费）
magpie provider test teleagent  # 3. 链路通不通（一次真实请求，花积分）
```

| 现象 | 原因 | 动作 |
|---|---|---|
| 插件列表里没有 | 没装成功 / 装到别的 profile | `magpie plugin add <spec>`；确认 `--profile` |
| 提示升级 TeleAgent | 已安装版本低于 2.7.1 | 将 TeleAgent 桌面端升级至 2.7.1 或更高版本 |
| 无法读取桌面端版本 | 安装包缺失、不可读或位于自定义路径 | 安装或修复桌面端，或设置 `TELEAGENT_APP_PATH` |
| 「数据目录不存在」 | 桌面端从没启动过 | 启动一次，让它初始化 `~/.local/share/TeleAgent` |
| 「未登录」 | 没有 `app-auth/token.json` | 桌面端登录后 `magpie plugin login teleagent` |
| 路径里出现 `users/__none__/app-auth/token.json` | 0.1.2 及更早版本把未登录时的占位选项当成账号 | 升级到 0.2.0 后重新执行插件登录；提交时会重新检测桌面端账号 |
| 插件登录成功，切换 magpie tab 又提示登录 | 旧版积分查询失败可能被宿主误判为模型登录失效 | 升级到 0.2.0 后执行一次 `magpie plugin login teleagent` 清除旧标记；积分 cookie 缺失只影响积分显示 |
| Windows DPAPI 无法解密 / 缺少 Local State | 不是同一个 Windows 用户，或桌面端尚未写出本机密钥 | 用登录 TeleAgent 的同一个系统用户启动 magpie；在该用户下重新登录桌面端 |
| `keychain_denied` | 拒绝了 `TeleAgent Safe Storage` 授权 | 钥匙串访问里删掉该条目，桌面端重登后重试 |
| 「凭据解密失败」 | 桌面端版本变了，加密格式不匹配 | 更新桌面端后重登；仍失败就是插件要适配 |
| `401` / `40108` 登录过期 | 约 30 天到期，没有 refresh token | 桌面端重登 → `magpie plugin login teleagent` |
| `40104` 签名无效 | 上游改了签名协议，或 pathname 少了 `/superCowork/sapi` | 更新插件；别反复重试换参数 |
| `40105` 请求疑似攻击 | 网关 apiKey 没取到（桌面端版本不受支持） | 更新插件；或 `export TELEAGENT_API_KEY=<本机值>` |
| `40109` 账号封禁 | 模型通道被封（积分仍可读） | 停手、换账号，见「封号复盘」 |
| `402` / `4029` 积分不足 | 余额不够 | `magpie quota` 看余额，签到，或换低倍率模型 |
| `429` / `4290` 限流 | 请求太密 | 等一会儿；持续出现就别再循环发 |
| `1210` 内容类型不支持 | 给不支持的模型发了图片 | 换 `chat-pro` / `chat-flash` |
| `400` 且提示「该模型始终思考，不支持关闭思考」 | agent / 宿主发了上游不认的思考档位（如 `medium`） | 0.1.2 起插件会自己削成 low/high/max，升级即可 |
| `413` 请求体过大 | 工具 schema 或附件太大 | 减工具、减附件（不是账号问题） |
| 积分显示「不可用」，模型正常 | cookie 库没初始化 / 分区不对 | 启动桌面端，进一次积分页让它写 cookie |
| 模型列表为空 | `config` 没生效或被别的插件覆盖 | `magpie plugin --json` 看 hooks |
| `404` 且提示「TeleAgent 没有模型 X」 | agent 传了目录外的模型 id | 用 5 个合法 id；插件本地就拦下，不打上游 |

### 思考档位（0.1.2 修的那一类）

上游只认 `low` / `high` / `max` 三档，**没有"关闭思考"这个概念**。而 agent 宿主
（magpie 网关、Claude Code 等）会按自己的通用理解往请求体里写 `reasoning_effort`，
写进去的值不一定是这三档——比如 Claude Code 经 magpie 网关会写 `medium`，
上游就直接回 400。

插件 0.1.2 起在**发出去之前**把档位削成上游认的：三档原样保留、`medium` 这类
就近落档、`off` 这类关闭写法直接删掉整个字段。所以这类 400 不该再出现；
如果还出现，打开 `verbose` 选项，日志里会有一行 `思考档位：X → Y` 说明它改成了什么。

两个容易混淆的错误：`40104` 是**签名不对**（token 是好的，更新插件）；
`40108` 是**身份不对**（token 坏了 / 过期，重新登录）。「积分能读但模型全拒」几乎一定是
`40109`，别继续试。

## 隐私

| 数据 | 位置 | 是否离开本机 |
|---|---|---|
| TeleAgent 登录凭据（JWT） | `users/<scope>/app-auth/token.json` | 否，只用于本机加签 |
| 设备指纹（deviceId / installId） | `app-auth/device-meta.json` | 否，只放请求头 |
| 桌面端版本号 | `app.asar` 中的 `package.json` | 否，只放请求头 |
| 积分 cookie | `Partitions/owner%3A<scope>/Cookies` | 否，只发 portal |
| 你的对话内容 | magpie 传给插件 | 是，只发给 TeleAgent 上游 |
| 聊天记录 / 技能 / 记忆 | 桌面端数据目录 | **不读** |

出站只有一个域名：

```text
https://agent.teleai.com.cn
├── /superCowork/sapi/api/v1/chat/completions     聊天
└── /meter/super-agent/user/portal/...            积分与签到
```

签名的请求**只会**发给这个 origin。magpie 的 `api` 是用户可改的配置，如果它被改成
别的域名（打错、从别处抄来、或恶意模板），插件会直接拒绝发请求并报错，不会把 JWT
签名和设备指纹送出去；比较的是 origin（协议 + 域名 + 端口），所以
`agent.teleai.com.cn.evil.test` 和 `http://` 降级都会被挡掉。

不写请求日志、不落盘请求/响应体、不打印 token 或 cookie、不上报账号信息。`magpie plugin --json`
和 `magpie quota` 的输出只有状态和数字，可以贴出来求助（贴前还是看一眼，别带完整路径）。
可以自己核对：

```bash
grep -rn "https://" index.mjs lib/     # 出站目标只有 agent.teleai.com.cn
grep -rn "token.json" lib/             # 只读，不写
```

## 开发

目录结构见上面「文件」表。测试全部离线：

```bash
~/.cache/magpie/bun/<ver>/magpie-bun test test/   # 用 magpie 自带的 bun
```

测试红线：不发真实网络请求、不调真实签到接口、不读真实凭据、不打印 cookie/token；
网络与系统解密调用可注入，SQLite 使用本地合成数据库。使用 Node/Bun 内置模块，零第三方运行时依赖。
GitHub Actions 在 macOS 和 Windows 上运行同一套测试；Windows 额外运行原生 DPAPI 和加密 cookie 测试。

沙箱手测：

```bash
bash scripts/sandbox.sh               # 隔离 HOME：只验证「未登录」分支，不发真实请求
bash scripts/sandbox.sh --real-home   # 真实 HOME：登录 + quota + 一次 provider test（花积分，只跑一次）
```

改代码后的最小自检：签名 → 单测（确定性 ts/nonce）+ 一次真实请求看是不是 `40104`；
模型元数据 → 单测对齐 `limit` / `modalities` / `rate`；portal → 单测（注入 `run` 与
`fetchImpl`）；guard → 单测（注入时钟与 `onIdle`）；入口 hooks → `magpie plugin --json`。
**别用真实账号跑重复验证**，一次失败就够定位了。

入口模块只导出一个函数（magpie 会把每个导出函数都当插件调用），辅助函数必须放 `lib/`。
`auth.refresh` 故意没有实现：凭据里没有 refresh token，假报「刷新成功」只会让过期问题更难查；
凭据失效时 `loader` 抛的错带 `error.signIn = 'expired'`，magpie 据此标记「需要重新登录」。

## 已知限制

- **平台**：支持 macOS、Windows；Linux 尚未适配
- **依赖逆向**：上游协议变了就 `40104`，需要适配
- **凭据约 30 天**：没有 refresh token，到期必须重登
- **图片只有 2 个模型**：`chat-pro` / `chat-flash`，其余三个实测不支持
- **积分 cookie**：支持明文及 Windows v10/旧 DPAPI 加密；其他加密格式会显示积分不可用，模型登录状态不受影响
- **多账号需要本机真有凭据**：插件不替你换号
- **封号无法预测**：内置限速只降低概率，不保证安全

## 与官方客户端的可识别差异

本插件**不伪装成官方客户端**，请求在若干维度上与官方客户端可区分，这是明确的取舍：

| 维度 | 官方客户端 | 本插件 |
|---|---|---|
| `messages[0]` | 固定人格串 | magpie agent 自己的提示词 |
| 工具集合 | 客户端内置工具 | magpie 的工具 |
| TLS 指纹 | Electron / Chromium | Node undici |
| 请求节奏 | 人工交互 | 可能突发，已加并发与限速 |

不建议伪造官方人格或客户端身份：既污染模型行为，也无助于账号申诉。

## 与 dsh-connect-teleagent 的关系

同样的 TeleAgent 接入思路还有一个 DeepSeek Harness 插件
（[dsh-connect-teleagent](https://github.com/anbulang/dsh-connect-teleagent)），那是**另一个
独立仓库**——宿主不同、接口不同、安装方式不同，两者只共享「逆向结论」这类知识，不共享代码，
也不需要一起装：

| | DSH 插件（另一个仓库） | 本仓库 |
|---|---|---|
| 宿主 | DeepSeek Harness | magpie / OpenCode |
| 接口 | pi-ai provider + 设置卡片 | OpenCode v1 插件 hooks |
| 登录交互 | 设置卡片按钮 | `auth.methods` 无输入登录 |
| 积分 | 卡片 + 输入框胶囊 | `auth.usage` + `magpie quota` |

## 免责声明

本项目是对本机已安装客户端行为的**互操作研究**，用于把已有账号接入自己的工具链。
仓库不包含任何真实账号凭据、cookie 或上游密钥。

- 请遵守 TeleAgent 与 magpie 的使用条款，以及当地法律
- 账号风险由使用者承担：插件已按已知教训内置限速与熔断，但不能保证账号安全
- 上游协议随时可能变化，插件不承诺长期可用

## License

[MIT](LICENSE)
