<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-wabi-dark.svg">
  <img src="assets/readme/hero-wabi.svg" alt="magpie-muse-web bridges a muse.ai web account into a Magpie provider through a local headless fingerprint browser" width="100%">
</picture>

<p>
  <img src="https://img.shields.io/badge/Provider-muse--web-8A4E2E?style=flat-square" alt="Provider muse-web">
  <img src="https://img.shields.io/badge/Model-muse--spark-3C5847?style=flat-square" alt="Model muse-spark">
  <img src="https://img.shields.io/github/v/release/CYoJkoY/MuseWeb2Magpie?style=flat-square&label=release" alt="Latest release">
  <img src="https://img.shields.io/badge/License-MIT-8A4E2E?style=flat-square" alt="MIT license">
  <img src="https://img.shields.io/github/actions/workflow/status/CYoJkoY/MuseWeb2Magpie/release.yml?style=flat-square&label=release" alt="Release workflow status">
</p>

<p><strong>把 muse.ai 的网页账号，安静地接进 Magpie。</strong></p>

<p>
  <a href="#readme-overview">概述</a> ·
  <a href="#readme-features">特性</a> ·
  <a href="#readme-architecture">工作原理</a> ·
  <a href="#readme-chat">对话与流式</a> ·
  <a href="#readme-tools">工具调用</a> ·
  <a href="#readme-models">模型与额度</a> ·
  <a href="#readme-choice">方案对比</a> ·
  <a href="#readme-connector">Connector</a> ·
  <a href="#readme-installation">安装</a> ·
  <a href="#readme-login">登录</a> ·
  <a href="#readme-data">数据与安全</a> ·
  <a href="#readme-usage">日常使用</a> ·
  <a href="#readme-settings">设置</a> ·
  <a href="#readme-performance">速度</a> ·
  <a href="#readme-troubleshooting">排查</a> ·
  <a href="#readme-development">开发</a> ·
  <a href="#readme-status">状态</a> ·
  <a href="#readme-support">支持</a> ·
  <a href="#readme-license">许可</a>
</p>

</div>

---

<a name="readme-overview"></a>

## <img src="assets/readme/icons/overview.svg" width="24" height="24" alt=""> 概述

**magpie-muse-web** 是一个非官方的 [Magpie](https://github.com/yetone/magpie) provider 插件，把 [muse.ai](https://muse.ai) 的网页账号接进 Codex、OpenCode 等 Agent。

provider id 是 `muse-web`，模型是 `muse-web/muse-spark`。每个账号在浏览器窗口里登录一次；之后 Magpie 通过插件自带的本机引擎，用一个无头的开源指纹浏览器与 muse.ai 聊天页对话，在多个账号之间调度请求，并在账号卡片上显示各自的用量。

muse.ai 没有公开 API。这个引擎把 Magpie 发来的 Chat Completions 请求变成网页上的一条消息，再把回复流式送回去。选哪个账号、忙时换号、失败重试都交给 Magpie 自己的调度；引擎只执行被点名的那一个账号。

<a name="readme-features"></a>

## <img src="assets/readme/icons/features.svg" width="24" height="24" alt=""> 特性

| 能力 | 说明 |
| :--- | :--- |
| **网页账号即模型** | 每个 muse.ai 网页账号单独出现在 Magpie 里，选号与换号由 Magpie 调度。 |
| **无头指纹浏览器** | 默认用开源指纹浏览器 Apostate 打开 muse.ai，保持稳定的 GPU / 屏幕 / 字体 / 时区指纹；缺失时自动下载固定版本并做 sha256 校验。 |
| **Chat Completions** | 流式与非流式，OpenAI 兼容；工具调用以标准 `tool_calls` 返回。 |
| **会话复用** | 每个账号只开一个页面，切换会话在页内跳转，不重新加载。 |
| **额度卡片** | 每张卡片显示该账号的每周用量、额外额度与状态。 |
| **忙时换号** | 一个账号同时只回答一条，忙时返回 429，由 Magpie 换号。 |
| **自愈** | 页面卡住、虚拟机预热、流式中断都有明确的 `error.code` 与 `Retry-After`。 |
| **本地优先** | 引擎只监听 `127.0.0.1`，cookie 与密钥只存在本机数据目录。 |
| **原生引擎 + TypeScript 驱动** | Go 负责 HTTP、存储和进程边界；TypeScript 只负责需要浏览器页面的操作，二者通过受约束的 NDJSON 协议连接。 |

<a name="readme-architecture"></a>

## <img src="assets/readme/icons/architecture.svg" width="24" height="24" alt=""> 工作原理

```text
Agent (Codex / OpenCode)
        │  Chat Completions
        ▼
Magpie gateway ── chooses account, retries, shows cards
        │  /v1/chat/completions  (Bearer engine.key)
        ▼
Go engine  ── 127.0.0.1:18611 · static native binary
   ├── HTTP / store  accounts.json + cookies + engine.key
   ├── auth / SSE    loopback auth, chat, usage, login, shutdown
   └── driver bridge NDJSON over stdin/stdout
        │
TypeScript driver ── prompt, tools, login, CDP and page evaluation
        │  Chrome DevTools Protocol
        ▼
Apostate / Chromium fingerprint browser  ── headless
        │  https://muse.ai  (muse.ai virtual machine)
        ▼
Reply text  →  streamed back as OpenAI chunks
```

插件按 OpenCode 插件规范编写。不经过 Magpie、直接装进 OpenCode 的用法还没有实测；多账号调度和额度卡片是 Magpie 的功能，OpenCode 自己只保存一个登录。

<a name="readme-chat"></a>

## <img src="assets/readme/icons/chat.svg" width="24" height="24" alt=""> 对话与流式

请求走 OpenAI 兼容的 Chat Completions，流式和非流式都支持。

- 每个账号在浏览器里只开一个页面，一直连着 muse.ai 的虚拟机。每个 Magpie 会话对应 muse.ai 的一个对话；切换会话就在这个页面里跳到对应的对话，不重新加载，约 0.5 秒。
- 同一会话继续聊时回到它的对话，只发最新一条消息。新会话或页面卡住时开新对话，把历史一次发过去；历史超过预算（约 40 万字符、80 轮）时保留 system 与最近若干轮，并在开头注明省略了多少条。
- 一个账号同时只回答一条（`maxConcurrency: 1`），忙时返回 429，由 Magpie 换账号。
- 页面提示额度用完时立刻返回 429，不用等首字超时。只看页面自己的提示，模型回答里出现这些字不算。
- 登录失效返回 401，Magpie 会提示重新登录。
- 错误响应带机器可读的 `error.code`；429/503 还带 `Retry-After`。常见值见[排查](#readme-troubleshooting)。
- 只发文本：消息里的图片、文件换成「[图片]」「[文件]」字样，其余内容照常发送。
- 页面在回答下方显示的“建议回复”按钮不算回答内容。

<a name="readme-tools"></a>

## <img src="assets/readme/icons/tools.svg" width="24" height="24" alt=""> 工具调用

muse.ai 的网页没有工具接口，而且它的助手自带云端虚拟机，默认会在自己的虚拟机里执行命令，而不是请求你的电脑。插件这样处理：

1. 请求带 `tools` 时，把工具列表写进提示词，并明确告诉模型：用户的文件和命令行在用户自己的电脑上，它的虚拟机碰不到。
2. 要求模型把工具调用写成 `tool_call` 代码块，里面是 `{"name": ..., "arguments": ...}`。必须用代码块，因为页面会按 Markdown 渲染回答，代码块外的反斜杠、星号和尖括号标签会被改掉。
3. 引擎从回答里解析出调用，只认请求里真有的工具名，作为标准 `tool_calls` 返回，`finish_reason` 是 `tool_calls`。
4. 工具结果和历史里的工具调用以同样的格式写回提示词。

流式回答里，正文按整行发出；从可能是工具调用的位置起先压住，回答结束后再发剩余正文和 `tool_calls`。

这是靠提示词实现的，不是原生函数调用：模型偶尔不按格式回答，或直接让你自己去运行命令，这时就当成普通文本回答返回。`tool_choice` 为 `none` 时不写工具说明；为 `required` 或指定工具时，提示词会要求模型必须调用，若模型只回文本，引擎会追加一次 repair 提示，仍不调用则返回 422 `tool_call_not_parsed`。

<a name="readme-models"></a>

## <img src="assets/readme/icons/models.svg" width="24" height="24" alt=""> 模型与额度

| 模型 | 输入 / 输出 | 上下文 | 工具调用 | 费用 |
| :--- | :--- | :--- | :--- | :--- |
| `muse-spark` | 文本 / 文本 | 按 128K 声明，输出 16K | 支持（见上） | 记为 0 |

muse.ai 没有公开上下文上限。按 128K 声明，是为了让客户端在对话过长前自己压缩。

### 额度卡片

额度取自 muse.ai 自己的「设置 → 使用情况」：引擎在账号的浏览器里开一个临时标签页读取，读完就关。

| 区块 | 含义 |
| :--- | :--- |
| **每周** | 方案的每周限额用了多少，什么时候重置。 |
| **额外额度** | 额外额度用了多少、还剩多少（例如「剩余 10 亿个词元」）。 |
| **状态** | `免费版 · 已就绪`，也可能是 `正在回答`，或 `闲置，下一条约需 30 秒唤醒`。 |

引擎预热后读一次；每次回答结束后最多每 2 分钟读一次；卡片数据超过 30 分钟也会重读。账号的虚拟机还在预热时读不到数据，2 分钟后再试。浏览器因闲置关掉后，不会为了读额度把它重新打开，卡片显示上一次的读数。

<a name="readme-choice"></a>

## <img src="assets/readme/icons/providers.svg" width="24" height="24" alt=""> 方案对比

### magpie-muse-web vs muse2api

[muse2api](https://github.com/czg86389-hub/muse2api) 是一个独立运行的 muse.ai 转 API 服务，[magpie-muse2api-plugin](https://github.com/d0nkey8urger-bot/magpie-muse2api-plugin) 把它接进 Magpie。两者的区别：

| | magpie-muse-web | muse2api + 插件 |
| :--- | :--- | :--- |
| Magpie 里看到的 | 每个 muse.ai 账号单独一个 | 一个 key，账号池在 muse2api 里 |
| 选号、换号 | Magpie 按账号调度 | muse2api 自己调度 |
| 额度卡片 | 每个账号的每周用量和重置时间 | 账号池里有几个可用 |
| 运行依赖 | 一个自动准备的浏览器 | Docker 或 Python，外加浏览器 |
| 后台进程 | 跟着 Magpie 走，闲置时关浏览器 | 常驻服务，Magpie 关掉后还在 |
| 工具调用 | 支持 | muse2api 默认关闭 |
| 生图、生视频、给其他工具用 | 不支持 | 支持 |

只在 Magpie 里用、想让 Magpie 管理多个账号，选这个插件；要生图生视频，或者要给 Magpie 以外的工具一个统一的 API，选 muse2api。两者的 provider id 不同（`muse-web` 和 `muse2api`），可以同时安装。

### magpie-muse-web vs magpie-muse-auth

`magpie-muse-auth`（provider id `muse`）走 Meta 的 Muse Code API，设备码登录，属于非官方 API 接入。

| | magpie-muse-web | magpie-muse-auth（Meta API） |
| :--- | :--- | :--- |
| 账号 | muse.ai 网页账号 | Meta Muse Code 订阅 |
| 模型 | `muse-spark` | Wonder、Spark 1.1–1.3 |
| 上下文 | 128K | 约 1M |
| 工具调用 | prompt 解析 | 原生 Responses tools |
| 浏览器 | 内置开源指纹浏览器或 Chromium 系浏览器 | 不需要 |
| 主要风险 | 网页改版、地区/代理 | 订阅条款、非官方 API |

要原生工具、大上下文、多模型，选 `muse`；要在网页账号上跑、让 Magpie 按账号显示额度，选 `muse-web`。

<a name="readme-connector"></a>

## <img src="assets/readme/icons/connector.svg" width="24" height="24" alt=""> Connector 版

如果引擎需要单独运行（服务器、多 Magpie 实例、或社区市场收录的版本），用 [`connector/`](connector/README.md)：

```sh
magpie plugin add magpie-muse-web-connector
export MUSE_WEB_ENGINE=http://127.0.0.1:18611
export MUSE_WEB_ENGINE_KEY="$(cat "$HOME/Library/Application Support/muse-web/engine.key")"
magpie plugin login muse-web
```

Connector 不启动浏览器、不读 cookie、不 spawn 进程，只连接你自己运行的引擎。和完整版使用同一个 provider id `muse-web`，**不要同时安装**。

<a name="readme-installation"></a>

## <img src="assets/readme/icons/installation.svg" width="24" height="24" alt=""> 安装

### 环境要求

- [Magpie](https://github.com/yetone/magpie)，在 0.1.1223 上验证过。
- 默认用开源指纹浏览器 [Apostate](https://github.com/heretic-tech/apostate) 打开 muse.ai：本机已有就复用；没有时引擎启动时自动下载一次固定版本（带 sha256 校验）到数据目录，以后复用。下载失败或设为 `MUSE_WEB_FINGERPRINT=0` 时，用本机的 Chrome、Edge、Chromium 或 Brave。Firefox 不能当登录窗口：引擎靠 Chrome DevTools Protocol 操作页面。
- 安装包已带当前平台和架构的 Go 原生引擎，日常使用不需要另装 Go；引擎会使用插件宿主提供的 TypeScript 运行时启动浏览器驱动。
- 如果从源码开发或运行测试，需要 Go `>=1.27.4` 与 Node.js `>=22.18`；具体命令见[开发](#readme-development)。
- 能访问 muse.ai 的网络。需要代理时见[设置](#readme-settings)。

### 命令

```sh
magpie plugin add magpie-muse-web       # npm 包名；如果 npm 上还没有，用下面这行
magpie plugin add github:CYoJkoY/MuseWeb2Magpie
magpie plugin login muse-web
```

也可以在 Magpie 的插件页添加对应的包名或 GitHub 地址，然后在账号页登录 `muse-web`。想登录多个账号，就多登录几次。

更新用 `magpie plugin update`；卸载用 `magpie plugin rm`（名字见 `magpie plugin list`）。卸载不会删除引擎的数据目录，不再使用时可以手动删掉。

想跑本地副本：

```sh
git clone https://github.com/CYoJkoY/MuseWeb2Magpie.git
magpie plugin add ./MuseWeb2Magpie
```

<a name="readme-login"></a>

## <img src="assets/readme/icons/login.svg" width="24" height="24" alt=""> 登录

**muse.ai（浏览器登录）**：会开两个窗口。系统默认浏览器里打开的是本机进度页（`http://127.0.0.1:<端口>/login/…`），只显示进度、每 2 秒刷新，那里不能登录。真正的登录在引擎另外打开的窗口里：默认是开源指纹浏览器 Apostate（本机已有或引擎自动准备的那份；装了多个浏览器时，登录前会先让你选一个，Apostate 在前），其余可选 Chrome、Edge、Chromium 或 Brave。请在那个窗口里照常登录，什么都不用复制。

登录后引擎向 muse.ai 确认会话，关掉登录窗口，再发一条很短的测试消息：账号真的能回答，才算登录成功。账号额度已用完的也算成功，只是暂时用不了。

- 账号默认以登录时间命名，例如「muse.ai 2026-10-13 14:03 登录」。
- 15 分钟内没登录完，这次登录作废，并说明卡在哪一步。
- 测试消息会在 muse.ai 的对话记录里留下一条“连通测试”。
- 再登录一次同一个 muse.ai 账号会更新原来那个账号（按 muse.ai 分配的虚拟机 ID 识别），名字和位置都不变，不会多出一个。
- 没有桌面的 Linux 打不开登录窗口，插件会直接说明。

**引擎账号 ID（高级）**：自己另外运行引擎（`MUSE_WEB_ENGINE`）时，填引擎给出的账号 ID。

<a name="readme-data"></a>

## <img src="assets/readme/icons/data-scope.svg" width="24" height="24" alt=""> 数据与安全

### 登录信息存在哪

Magpie 里只存引擎账号 ID，cookie 留在引擎的数据目录里，文件只有当前用户可读：

| 系统 | 数据目录 |
| :--- | :--- |
| macOS | `~/Library/Application Support/muse-web` |
| Windows | `%APPDATA%\muse-web` |
| Linux | `$XDG_DATA_HOME/muse-web`，默认 `~/.local/share/muse-web` |

目录里有 `accounts.json`（账号和 cookie）、`engine.key`（Magpie 访问引擎用的密钥）、`engine.log`（请求日志，超过 5 MB 轮转）和浏览器配置。日志不记录对话内容和 cookie。

Magpie 在会话到期前 10 分钟自动续期；续不上时额度卡片显示「已过期」，重新登录即可。

### 安全边界

<img src="assets/readme/icons/security.svg" width="18" height="18" alt=""> 以下边界是设计约束，不是可选项。

- 引擎只监听 `127.0.0.1`，所有 `/v1/*` 都要求 `engine.key`；登录进度页只带一个随机 ID，不显示 cookie。
- `accounts.json` 和 `engine.key` 以 0600 写入（Windows 用当前用户目录的 ACL）；cookie 只在引擎、账号自己的浏览器上下文和 muse.ai 之间流动。
- `engine.log` 不记录对话正文或 cookie；错误体和日志里的 Bearer / token / hatch cookie 会脱敏，但上游返回的普通文本仍可能出现在错误里，分享日志前请自己检查一遍。
- 插件不会复用你日常浏览器的登录态；登录窗口用的是临时资料目录，完成后删除。

<a name="readme-usage"></a>

## <img src="assets/readme/icons/usage.svg" width="24" height="24" alt=""> 日常使用

```sh
magpie codex muse-web/muse-spark       # 让 Codex 用 Muse Spark
magpie opencode muse-web/muse-spark    # 让 OpenCode 用 Muse Spark
magpie provider test muse-web          # 发一条真实的小请求，检查整条链路
```

也可以在 Magpie 配置的任何 Agent 里选 `muse-web/muse-spark`。Agent 的请求经 Magpie 网关分到各个账号。

<a name="readme-settings"></a>

## <img src="assets/readme/icons/settings.svg" width="24" height="24" alt=""> 设置

都是可选的环境变量，在启动 Magpie 的环境里设置：

| 变量 | 作用 | 默认 |
| :--- | :--- | :--- |
| `MUSE_WEB_PROXY` | 代理地址，或 `direct` 表示直连 | 依次用 `https_proxy` 等环境变量、系统代理，都没有就直连 |
| `MUSE_WEB_BROWSER` | `headless`、`hidden`（窗口放到屏幕外）或 `show` | `headless` |
| `MUSE_WEB_FINGERPRINT` | 设为 `0` 时不使用也不下载指纹浏览器 | 使用 |
| `MUSE_WEB_FINGERPRINT_BROWSER` | 指定要复用的 Apostate 可执行文件路径 | 自动查找本机与数据目录 |
| `MUSE_WEB_FINGERPRINT_VERSION` | 自动下载的 Apostate 版本 | 固定版本 |
| `MUSE_WEB_FINGERPRINT_PLATFORM` | Apostate 的指纹平台（`windows`、`macos`、`linux`） | 跟随当前系统 |
| `MUSE_WEB_CHROME` | 指纹浏览器不可用时的浏览器路径，必须是 Chromium 系；`firefox.exe` 不行。登录时选的浏览器只覆盖那一次登录窗口 | 自动查找 Chrome、Edge、Chromium、Brave |
| `MUSE_WEB_IDLE_MIN` | 闲置多少分钟后关浏览器 | `60` |
| `MUSE_WEB_PREWARM` | 设为 `0` 时不预热 | 预热 |
| `MUSE_WEB_VERIFY_LOGIN` | 设为 `0` 时登录后不发测试消息 | 发送 |
| `MUSE_WEB_ENGINE_PORT` | 引擎端口 | `18611` |
| `MUSE_WEB_HOME` | 数据目录 | 见上表 |
| `MUSE_WEB_ENGINE` | 改用自己运行的引擎地址，插件不再自己启动引擎 | 插件自带 |
| `MUSE_WEB_ENGINE_KEY` | 外部引擎的 `engine.key`；配合 `MUSE_WEB_ENGINE` 使用 | 读数据目录的 `engine.key` |
| `MUSE_WEB_SITE` | 改用别的 muse.ai 兼容站点（测试 / 镜像） | `https://muse.ai` |

<a name="readme-performance"></a>

## <img src="assets/readme/icons/performance.svg" width="24" height="24" alt=""> 速度

- 账号页面已连上时，不管是新会话还是继续旧会话，准备页面约 0.5 秒，首字通常 2～5 秒，主要是 muse.ai 自己生成的时间。
- 只有打开页面时要连 muse.ai 的虚拟机，约 10～20 秒：引擎刚启动、浏览器闲置后被关掉、页面卡住需要重新加载时。
- 闲置超过 60 分钟，引擎会关掉浏览器省资源（`MUSE_WEB_IDLE_MIN` 可调长）。
- Magpie 加载插件时就启动引擎；引擎启动和每次登录后都会预热各账号，第一条消息不用等冷启动。
- 引擎每 30 分钟检查一次：超过 6 小时没被唤醒的账号，会续一次会话并唤醒它的虚拟机。这不计入使用，也不会推迟浏览器的闲置关闭。
- 冷启动时各账号并行预热，额度读取同时最多 3 个账号；驱动协议的热路径测量方法和实测数字见 [`docs/perf.md`](docs/perf.md)。

<a name="readme-troubleshooting"></a>

## <img src="assets/readme/icons/troubleshooting.svg" width="24" height="24" alt=""> 排查问题

先看数据目录里的 `engine.log`。每条请求一行，写明用了哪个账号、页面是复用（`kept`）还是新开（`new`）、是回到旧对话（`back`）还是开新对话（`new-thread`）、发了整段历史还是最新一条、首字用时；带工具的请求还会写 `tools=2→shell` 或 `tools=2→text`。

| 现象 | 原因和处理 |
| :--- | :--- |
| 卡片显示「已过期」或请求返回 401 | 会话失效，重新登录该账号 |
| 一直返回 429 | 账号正忙，或额度已用完，看卡片上的每周用量 |
| 首字等了很久，提示虚拟机正在预热 | muse.ai 那边的虚拟机还没就绪，稍后再试 |
| 卡片上没有百分比 | 虚拟机还在连接，2 分钟后自动重读 |
| 登录反复不完成，账号数一直是 0 | 默认浏览器里那个页面只是进度。请在另开的指纹浏览器或 Chromium 窗口里登录，并等引擎确认会话后它自己关掉。看 `engine.log` 有没有 `verify` 或 `warm`；状态页上的错误若是 `/api/session HTTP 403`，是出口地区或代理问题，可试 `MUSE_WEB_PROXY=direct` |
| 日志显示指纹浏览器下载或安装失败 | 引擎会自动改用本机 Chrome/Edge/Chromium。检查网络代理后重试，或用 `MUSE_WEB_FINGERPRINT_BROWSER` 指定本机已有的 Apostate；确实不想用它时设 `MUSE_WEB_FINGERPRINT=0` |
| 登录失败：「已登录，但账号没有回答测试消息」 | 会话拿到了但对话不通，常见于虚拟机还在预热，稍后重新登录 |
| Agent 说它看不到你的文件，或让你自己运行命令 | 模型这次没按工具格式回答，重试或换种说法；日志里会是 `tools=…→text` |
| 连不上 muse.ai | 检查网络，或用 `MUSE_WEB_PROXY` 指定代理 |

### 错误码

响应里的 `error.code`：

| code | HTTP | 含义 | 处理 |
| :--- | :--- | :--- | :--- |
| `session_expired` | 401 | 会话被 muse.ai 登出 | 重新登录该账号 |
| `account_busy` | 429 | 这个账号正在回答 | Magpie 换号；`Retry-After: 1` |
| `quota_spent` | 429 | 这个账号额度用完 | 等重置或换号；`Retry-After: 60` |
| `prompt_too_long` | 413 | 页面拒收过长的消息 | 开新会话或减少历史 |
| `vm_warming` | 503 | 账号虚拟机还在预热 | 10 秒后重试 |
| `page_unavailable` | 503 | 页面没加载出来 | 10 秒后重试 |
| `send_failed` | 503 | 消息没有发出去 | 重试 |
| `stream_interrupted` | SSE | 流式回答中途失败 | 重试该轮 |
| `tool_call_not_parsed` | 422 | required / 指定工具没有被调用 | 重试或换模型 |

### 不支持

- 把图片、文件传给 muse.ai，以及单独的生图、生视频接口。聊天页自己生成的图片和视频会以链接附在回复文字后面。
- 用 Firefox 登录：进度页可以开在默认的 Firefox 里，登录窗口不行。
- 账号密码登录：只支持在浏览器窗口里登录。
- Responses、Messages 接口：引擎只提供 Chat Completions，Agent 的其他接口由 Magpie 转换。

<a name="readme-development"></a>

## <img src="assets/readme/icons/development.svg" width="24" height="24" alt=""> 开发

```sh
npm run typecheck      # TypeScript 类型检查（源码与测试都在严格检查内）
npm run no-javascript  # 确认仓库里没有 .js / .mjs 源文件
npm run build:engine   # 用 Go 构建当前平台的本地引擎
npm run test:go        # Go 单元测试
npm run bench          # Go 驱动协议基准测试（事件解码、请求编码、账号查询）
npm test               # 插件契约 + TypeScript / Go 引擎集成测试
```

插件、浏览器驱动和测试使用 TypeScript，HTTP 引擎与账号存储使用 Go；不产出也不提交 JavaScript 源文件。Go 引擎的 HTTP 和存储部分不依赖 Node；浏览器驱动由宿主运行时加载 `engine/driver.ts`。

`npm run build:engine` 需要 Go；`npm test` 的 `pretest` 会自动构建当前平台的引擎。CI 会先安装 Node.js 与 Go，再执行类型检查、no-JavaScript 守卫、Go 检查和完整测试。

发布：先把 `package.json` 的版本号和 `CHANGELOG.md` 里同名小节准备好，再推送同名 tag。`.github/workflows/release.yml` 会校验 tag 与版本号一致、跑完整测试、`npm pack`，然后把 tgz 和 `assets/icon.png`、`assets/icon.ico` 传到 GitHub Release，发布说明取自 CHANGELOG 对应小节。补发已有 tag 时，在 Actions 里手动触发 `release` 并填入 tag。

```sh
git tag v0.11.0
git push origin v0.11.0
```

没装浏览器时，用到浏览器的测试会自动跳过。Linux 环境可以用 Docker 跑：

```sh
docker build -t magpie-muse-web-linux-test test/linux
docker run --rm -v "$PWD:/source:ro" magpie-muse-web-linux-test sh -c 'cp -a /source /plugin && cd /plugin && npm ci && npm test'
```

### 代码结构

```text
MuseWeb2Magpie
├── index.ts                 Magpie / OpenCode 插件：登录、续期、额度卡片、启动引擎
├── connector/
│   └── index.ts             只连外部引擎的轻量版（provider id 相同）
├── engine/
│   ├── driver.ts            Go 引擎启动的 NDJSON 驱动：浏览器、登录、页面评估
│   ├── muse.ts              浏览器里的 muse.ai 页面操作
│   ├── cdp.ts               Chrome DevTools Protocol 客户端
│   ├── browser.ts           浏览器查找、启动、参数、清理
│   ├── fingerprint.ts       Apostate 的查找、下载、校验与指纹参数
│   ├── prompt.ts            把对话历史拼成发到页面的文本
│   ├── tools.ts             工具调用：提示词与解析
│   ├── login.ts             浏览器登录窗口
│   └── paths.ts · net.ts · local-fetch.ts · parent.ts · version.ts
├── engine-go/
│   ├── main.go              原生引擎入口、父进程守护与预热 / 保活调度
│   ├── server.go            loopback HTTP、SSE、鉴权和错误映射
│   ├── store.go             私有账号存储和 cookie 续期
│   ├── driver.go            TypeScript 驱动监督、请求复用和回调
│   └── login_page.go        登录进度页（模板转义）
└── test/                     契约与引擎测试
```

<a name="readme-status"></a>

## <img src="assets/readme/icons/roadmap.svg" width="24" height="24" alt=""> 状态与路线

当前版本 **0.11.0**：TypeScript 源码、Go 原生 loopback 引擎、稳定的网页账号接入、会话复用、工具调用、额度卡片与自动续期；冷启动与驱动协议经过一轮性能剖析和优化。

路线上的工作主要是提升与网页改版的兼容性、改进错误恢复与诊断，以及让引擎的部署形态更灵活。图片、文件上传与生图生视频不在计划内——那是 muse2api 的方向。

<a name="readme-support"></a>

## <img src="assets/readme/icons/support.svg" width="24" height="24" alt=""> 支持

用 [GitHub Issues](https://github.com/CYoJkoY/MuseWeb2Magpie/issues) 报告 bug、兼容性问题与功能请求。请不要在 issue 里贴 cookie、`engine.key` 或未脱敏的日志。

<a href="https://cyojkoy.github.io/Payment/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/support-cta-dark.svg">
    <img src="assets/readme/support-cta.svg" alt="Support magpie-muse-web through the maintainer payment page" width="100%">
  </picture>
</a>

<a name="readme-license"></a>

## <img src="assets/readme/icons/license.svg" width="24" height="24" alt=""> 许可与致谢

**MIT License**，见 [`LICENSE`](LICENSE)。页面操作逻辑移植自 [muse2api](https://github.com/czg86389-hub/muse2api)（MIT）；登录后发测试消息的做法参考了 [magpie-muse2api-plugin](https://github.com/d0nkey8urger-bot/magpie-muse2api-plugin)。

这是非官方的社区插件，和 muse.ai、Magpie 都没有关联。它通过 muse.ai 的网页会话工作，muse.ai 改版后可能失效；请遵守 muse.ai 的服务条款，账号使用风险由使用者自己承担。

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-CYoJkoY%2FMuseWeb2Magpie-181717?style=flat-square&logo=github)](https://github.com/CYoJkoY/MuseWeb2Magpie)

</div>

---

## English

An unofficial [Magpie](https://github.com/yetone/magpie) provider plugin for muse.ai. Sign in to each muse.ai account in a browser window; Magpie then chats with Muse Spark (`muse-web/muse-spark`) through a headless fingerprint browser the plugin's local engine drives, schedules requests across the accounts, and shows each account's weekly usage on its card.

Tool calls are supported through the prompt: the model writes them in `tool_call` code blocks, which come back as standard `tool_calls`; `tool_choice: required` gets one repair turn. Long histories are trimmed to roughly 400K characters / 80 turns with an explicit omission note. Errors carry `error.code` and 429/503 responses carry `Retry-After`.

Install with `magpie plugin add magpie-muse-web` (or `github:CYoJkoY/MuseWeb2Magpie` if npm is not published yet), then `magpie plugin login muse-web`. Sign-in opens two windows: the system browser shows a local progress page, and the separate window where you actually sign in defaults to the open-source fingerprint browser Apostate. It reuses a local copy first; otherwise the engine downloads a pinned, sha256-checked release into its data directory, and falls back to Chrome, Edge, Chromium or Brave when that fails. Firefox cannot be that window. Text only. MIT licensed. For the Meta Muse Code API instead of the web account, see `magpie-muse-auth` (provider `muse`).
