# agy-cli

把本机的 Antigravity CLI（`agy`）接成 Magpie 里的一个模型 provider。装好以后，
OpenCode、Claude Code 等客户端经由 Magpie 调用 agy 向本插件开放的模型，请求实际由
`agy` 进程完成。

**[English → README.en.md](README.en.md)** ｜ 来源、版权与迁移说明见 [NOTICE.md](NOTICE.md)

## 这是什么

插件以 Magpie provider 的形式运行。客户端发来 Anthropic Messages 格式的请求，插件把它
翻译成 ACP（Agent Client Protocol）消息，交给本机的 `agy acp` 进程处理，再把输出翻译回
流式响应。

- 底层是真正的 agy CLI，走它自带的 ACP 通道。ACP 握手里的 `clientInfo` 是本插件自己的
  包名和版本（`opencode-agy-cli-auth`），不冒充 Zed 或其它编辑器。插件自己只在一种情况下请求 Google
  的接口：agy 因地区拒绝 `/usage` 时，按 agy 的方式读额度（见「额度」）。
- 客户端自己的工具（读写文件、执行命令等）通过 MCP 暴露给模型。工具由客户端执行，结果
  回传到同一轮 agy 对话里，模型看到的是原生工具调用。
- 账号风险不由插件决定。Google 的使用政策变化时，插件无法替你保证账号不受限制。

## 与 Antigravity ACP 的区别

社区里的 Antigravity ACP（`antigravity-acp`）走的是同一个渠道：Antigravity 的模型经由 ACP。
两者的区别：

- **运行的程序**：Antigravity ACP 自己下载 Google 的 ACP 服务端（`agy_acp_server.par`，
  约 400 MB），依赖 Antigravity IDE 的登录。本插件运行 `agy` CLI（`agy acp`）：用你自己装好的；
  机器上没有时，在 Magpie 里登录会按 Google 官方安装脚本的方式装一份（见「环境要求」）。
- **会话**：Antigravity ACP 每个请求开一个新会话，把历史当作上下文带上。本插件维护一个
  agy 进程池，同一段对话复用同一个 agy 会话，重启后用 `session/resume` 接上；只有接不上时
  才重放历史。agy 会把一条提示词截在 128 KiB，所以 agy 1.5.17 起，更长的重放（或很长的粘贴）
  分几条提示词发完，除最后一条外每条都在模型回答前取消，直到模型的窗口
  （`AGY_BRIDGE_MAX_REPLAY_BYTES`）；放不下的较早历史会明确告诉模型。magpie 的 image-slim 把较早的图片换成占位文字（Codex 上是整段
  view_image 结果换成一行字），或 magpie 为满足大小、图片数上限省去较早的图片时，会话照常复用。
- **工具调用**：Antigravity ACP 把工具调用作为回复的 `tool_calls` 结束这一轮。本插件把
  客户端的结果送回同一轮 agy 对话（见下文「工具桥接」）。
- **额度**：本插件读 agy 自己的 `/usage` 报告；Antigravity ACP 读每次回复带的配额。

## 工具桥接

agy 连接 `--ide-mcp-port` 时会运行 `nc 127.0.0.1 <端口>`。插件在 agy 的 PATH 最前面放一个
私有的 `nc`，它把这条连接接到插件自己的 MCP 服务上；控制端口只监听本机回环地址，每个进程
有自己的令牌。

- 这依赖 agy 拨号的方式，不是 agy 公开承诺的接口，已在 1.4.12 和 1.5.0 上验证。agy 低于
  1.4.12 时，插件会直接报错并提示升级。
- 这个 `nc` 只对插件启动的 agy 进程生效，但对这些进程来说，它替换了 agy 运行的所有 `nc`。
- 客户端的每个工具都带 `_meta: {"antigravity/alwaysLoad": true}` 列出。不带的话，agy 会把较大的工具改为按需加载，不放进模型的函数列表，模型就用不到它们（#989）。
- 模型一次请求多个工具时，agy 也是一个一个发出的：每个桥接工具调用前，agy 都会先跑一遍自己的安全检查（`sir_flash_lite`，约 1.3–2.6 秒），等上一个工具的结果回来才发下一个。所以客户端看到的是一连串只带一个 `tool_use` 的回复（用量里记成 0 token 的请求），每多一个工具多等约 2 秒。这是 agy 自己的行为，插件这边没有开关能改；插件也不会把工具改成 agy 内置工具的名字来绕过这个检查（#1193）。

## 功能

- **agy 开放的模型**：模型列表以 ACP 会话里 agy 给出的模型选项为准。`agy models` 列出的
  模型如果没有在会话里向本客户端开放（agy 可能只向它认可的客户端开放 Claude、GPT-OSS），
  就不会出现在列表里。列模型时插件会先用 `agy acp` 开一个会话（不发 prompt）问 agy 开放了哪些，
  问到之前只列 Gemini。上次 agy 列出并开放的模型存在会话状态文件旁边的 `models.json`，
  重启后先列它，同时再问一次 agy：列出的和会话开放的都再问，列表变了（换了账号或套餐）也再问。模型和思考等级可以在会话中切换，
  历史保留。`agy models` 带 `--settings '{"modelProvider":""}'` 运行，所以
  settings.json 里的 `"modelProvider": "gemini"`（AI Studio 密钥）不影响这里的列表，
  列出的是 Google 账号的模型；AI Studio 密钥请在 Magpie 的 Providers 页加成 Google Gemini。
- **流式输出与思考摘要**：思考摘要以 `thinking` 块返回，设置 `AGY_BRIDGE_THINKING=0` 可关闭。
- **图片输入**：支持内联 base64 的 PNG、JPEG、GIF、WebP。需要 agy 1.5.0 或更新版本，
  因为图片能力要由 ACP 服务端声明。工具返回的图片（如 `read` 读到的截图）也作为提示里的
  图片交给 agy：走 MCP 的话，agy 会把它存成文件，模型看不到。
- **工具调用**：支持并行和连续调用。运行超过 150 秒的工具会先收到 "still running" 的
  占位响应，真正的结果送达后继续同一轮对话，每个调用只在客户端执行一次。
- **会话续接**：每轮结束后记录会话。重启 Magpie 或插件后，只要历史和指令的哈希一致，
  就用 `session/resume` 接上上下文。agy 的提示缓存跟着它运行的目录走，所以接上的会话
  回到原来的临时目录里运行，缓存照样命中。状态文件只存会话 ID、哈希和这个目录，不存消息原文。
- **隔离运行**：不读取你的全局 MCP 配置。每个 agy 进程使用临时 agent。agy 为它自己的
  工具发起的权限请求（shell、写文件、浏览器等）一律拒绝；客户端工具经桥接的 `ide-tools`
  调用时发起的请求放行一次，这些工具在客户端里运行，受客户端自己的权限管。真正的操作
  都在客户端侧完成。
- **助手预填**：以 assistant 结尾的预填请求（SillyTavern 预设、继续写、bot 框架）不再
  400 拒绝：预填留在本轮并渲染为续写载体，会话跨轮保持对齐，见下文「助手预填」。
- **网页搜索**：给 Magpie 的网页搜索提供 `agy-cli:agy`（`magpie search add agy-cli`），
  用的是 agy 自己的 `search_web`：插件开一个只有这一个工具的 agy 会话，让它搜这次的查询，
  从 agy 保存的这一步输出里读出摘要和来源，然后取消这一轮，模型不写回答。搜索由 agy 在
  Google 那边完成，插件不直接请求 Google。每条结果的标题是来源的域名，链接是 Google 的
  跳转地址（agy 给出的就是这样），正文是摘要里引用这个来源的句子。按账号搜索时，用的是
  这个账号的 agy 登录。
- **额度查看**：在 Magpie 里查看 agy 订阅的用量窗口。每个模型的窗口（它所在额度池用得最多的那个）也是 Magpie 路由给这个模型排账号的依据：路由组按剩余额度排它，额度池用完的模型会让给下一个成员。插件直接向 Google Code Assist 读额度时，Magpie 还会显示这次读取给出的账号套餐和邮箱。

## 助手预填（assistant prefill）

客户端的请求以一条**纯文本 assistant 消息**结尾时（SillyTavern 预设的预填、
「继续写 / Impersonate」、bot 框架的拼装），旧版会直接 400 拒绝。现在这段
预填被当作本轮的一部分：

- 预填留在本轮尾部，会话账本（expectedMessages，客户端原字节）与客户端自己
  的历史跨轮对齐——预填轮之后会话照常复用，不再整段重放；
- 预填文本渲染为一条续写载体（提示行 + 原文），发给 agy 让模型从停下的地方
  接着写；
- `AGY_BRIDGE_PREFILL=0` 恢复原来的 400 拒绝；`AGY_BRIDGE_PREFILL_CARRIER_NOTE`
  自定义载体提示行。

已知限制：与 live tool_result 共存的预填、以及未应答 tool_use 后紧跟的预填仍被 400 拒绝；前面没有 user 消息的
连续 assistant 尾整段视为预填（该轮降级为新会话，下一轮自愈）；向客户端开放
哪些模型仍由 agy 决定。

## 环境要求

- Antigravity CLI（`agy`），带 `acp` 子命令。机器上没有 agy 时（比如 Magpie 的 Docker 容器里），
  Magpie 0.1.4246 起在 Magpie 里点 Sign in 会先装好它：从 Google 官方安装脚本用的同一个地址下载、
  校验 sha512，放在数据目录里（`$XDG_DATA_HOME/magpie-agy-cli/agy`，没设时是
  `~/.local/share/magpie-agy-cli/agy`；Windows 是 `%LOCALAPPDATA%\magpie-agy-cli\agy.exe`）。
  容器的数据目录在 /config 卷里，重启后还在。你自己装的 agy 优先。在 Magpie 里登录需要 1.5.0 起的 agy（`agy acp --login`）；更早的版本请先在终端运行一次 `agy` 登录。
  文本与工具调用已在 1.4.12 和 1.5.0 上验证；图片输入需要 1.5.0。
- 支持 OpenCode 风格 provider 插件的 Magpie。额度查询已在 Magpie 0.1.1599 上验证。
- agy 版本低于 1.4.12 时，会话会被拒绝（见「工具桥接」）；低于 1.1.11 时，额度查询也会被
  拒绝，以免旧版本把 `/usage` 当成模型提示词。
- **自动更新**：插件启动的 agy 进程默认带 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，免得进程池里的
  多个进程同时更新同一个可执行文件。你自己在终端里运行的 agy 不受影响，照常更新。你自己设置了
  `AGY_CLI_DISABLE_AUTO_UPDATE`（包括设为 `false`）时，插件原样使用你的值。只通过本插件使用
  agy 的话，请定期在终端里运行一次 `agy` 让它更新：版本过旧本身也更显眼。插件自己装的那份由插件
  保持最新：启动一分钟后查一次，之后每 6 小时查一次，有新版就下载、校验、试运行后替换；你设置了
  `AGY_CLI_DISABLE_AUTO_UPDATE` 时不更新。

## 安装

从 Magpie 社区插件市场安装（推荐）：在 Magpie 的 Plugins 页找到「Antigravity (local agy CLI)」点安装，或在终端运行：

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

装好后 provider id 是 `agy-cli`，模型写成 `agy-cli/<模型>`。默认并发 16，可在 Magpie 的 Providers 页 Concurrency 里改（0 表示不限）。

安装完成后在 Magpie 里登录即可，不需要先开终端。

## 使用

1. 在 Magpie 的 Providers 页找到 `agy-cli` 并点击 Sign in。agy 已经登录时直接完成；
   没登录时插件运行 agy 自己的 Google 登录（`agy acp --login`），Magpie 打开登录页，
   登录后把页面显示的授权码（或整个页面地址）粘贴回 Magpie。Magpie 在服务器或 Docker
   里也一样。登录的有效期是 15 分钟。Google 凭据始终由 agy 自己保管（系统钥匙串），
   插件不保存；agy 列出账号的模型（`agy models`）后才算登录成功。账号在 Magpie 里以 agy
   存的 Google 邮箱命名（只从钥匙串里读这一项）。
   要再加一个 Google 账号，点 agy-cli 的 Add another account（或 Sign in），选「添加另一个
   Google 账号」。新账号有自己的 agy 主目录（`~/.local/state/magpie-agy-bridge/accounts/`
   下），它的登录保存在那个目录里的文件中，不动系统钥匙串里原来那个账号。每个账号单独一行，
   用量分开显示，可以像其他 provider 的账号一样切换和轮换。
   agy 自己只保存一个 Google 账号。为了让 agy 当前的账号在 agy 换登别的账号（比如在终端里）
   之后还能用，插件会把它的登录按 agy 存的原样复制一份，放到上面那个目录下它自己的主目录
   （`own…`，文件只有你自己能读）。agy 换到别的账号后，这个账号的用量、模型和请求就用这份
   复制运行 agy。系统钥匙串只读不写。0.1.113 之前就已不在 agy 里的账号没有这份复制，需要再登录一次。
   用过已退役的 Antigravity 插件（`antigravity`）的话，Magpie 的 Providers 页顶上会提示把那里的
   账号移过来，点 Move 即可；也可以在 agy-cli 的 Import accounts from a file… 里选那份登录记录
   或 agy 的令牌文件。它们本就是 Antigravity 自己的 Google 登录，每个账号放进自己的 agy 主目录，
   由 agy 检查通过后才加入，凭据不会发到别处。
2. 模型名写成 `agy-cli/<模型>`。agy 对同一模型不同思考等级给出的多个模型 ID，
   在这里会合并成一个模型的多个变体，请求时再映射回对应的 agy ID。
3. 在客户端里选用这个模型即可。

## 并发

- 插件自己的进程池上限由 `AGY_BRIDGE_MAX_PROCS` 决定，默认 16 个 agy 进程。
- Magpie 的 Providers 页有单独的 Concurrency 设置，可填 0–1000，0 表示不限制。
  你在页面里改的值会覆盖 `package.json` 里 `magpie.maxConcurrency` 的默认声明（16）。
- 进程池已满、又找不到可以淘汰的进程时，插件返回 HTTP 503。建议两处数值保持一致：
  Providers 页的并发数超过进程池上限，多出来的请求就会得到 503。

## 平台

- **macOS、Linux**：支持。
- **原生 Windows**：支持 `.exe`、`.cmd`、`.bat` 的查找与启动，后台更新检查不弹控制台窗口，
  并支持 `magpie quota`。目前只有命令构造的单元测试，尚未在 Windows 实机完成端到端验证。

## 额度

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

额度数据来自 agy 自己的 `/usage` 报告，显示的是当前 agy 登录账号的订阅窗口，按模型组
分别列出。同一组的模型共用这一组的 5 小时和每周额度，所以 Magpie 显示各组，并在「全部模型」
里列出组里的每个模型，读数是这一组用得最多的那个额度（先用完的那个；Google 自己给每个模型的
读数就是组的读数）。插件不写 Google 令牌，也只把它发往 Google，查询的始终是 agy 当前登录的账号。没有可测量数据的窗口会显示
"Limits not available"，而不是 0% 或 100%。

在 Antigravity 未开放的地区，agy 会在资格检查时拒绝 `/usage`（"not currently available in
your location"），尽管它自己查的额度已经拿到了。这时插件按 agy 的方式自己查：用 agy 存的登录，
以 agy 的 User-Agent 依次请求 Google Code Assist 的 `loadCodeAssist` 和
`retrieveUserQuotaSummary`。快到期的访问令牌只在内存里续期，不写回。个人 Google 账号的
`loadCodeAssist` 没给项目时，按 Google 给所有个人账号用的 `aicode-consumers` 项目查（agy
自己不带项目查，Google 会拒绝）。这次查询也失败时，账号显示 agy 的拒绝原因和查询失败的原因，
不显示数字。

未登录的 agy 一运行就会在浏览器里打开 Google 登录页，所以插件在为额度或模型列表运行 agy 之前，
先看系统钥匙串（macOS）或凭据管理器（Windows）里 agy 存的登录，只读有没有、何时到期。没有登录、
登录已过期且无法续期、或 agy 已在这份登录上失败过时，不运行 agy，账号显示登录已过期，直到重新登录。
其他失败的额度查询等 10 分钟再试，每次翻倍，最长 6 小时。

macOS 上，以 LaunchDaemon 方式运行的 Magpie 不在你的登录会话里，读不到登录钥匙串，agy 在那里也读不到。
这时 agy 自己的账号用 Magpie 窗口为它复制的那份登录（见上文）；没有复制的，账号会说明原因：
改用 `magpie daemon install`（以你自己的服务运行）或 Magpie 应用，或用“添加另一个 Google 账号”登录，
它的登录保存在文件里。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 PATH 查找 | 指定 agy 可执行文件 |
| `AGY_BRIDGE_MAX_PROCS` | 16 | agy 进程池上限 |
| `AGY_BRIDGE_THINKING` | 开启 | 设为 `0` 关闭思考摘要 |
| `AGY_BRIDGE_EFFORT` | 未设置 | 强制思考等级：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | 关闭 | **⚠️ 有封号风险，不建议开启。** 设为 `1` 去掉 agy 自带的提示组件，发往上游的请求就和官方 agy 客户端的不一样了；有用户反馈开启几个小时后账号被封。见下文「精简 agent」 |
| `AGY_BRIDGE_TELEMETRY` | 关闭（agy 不上报） | 插件启动 agy 时带上 `--disable-telemetry`（agy 的 `acp --help` 没这个开关就带不上）；设成 `1` 保留 agy 自己的上报 |
| `AGY_BRIDGE_ALLOW_AGY_TOOLS` | 关闭 | 设为 `1` 让每个 `agy acp` 带 `--dangerously-skip-permissions` 启动，agy 自带的工具（shell、改文件、浏览器）自动放行，不再由 bridge 逐个拒绝 `session/request_permission`。客户端 `ide-tools` 仍在客户端自己的权限下运行。agy 的工具在 magpie 所在的电脑上以你的用户权限运行，凡是到达这个 provider 的请求都能用：另一台机器上的客户端、或持有网关密钥的任何人，都能在这台电脑上执行命令。只有你自己用时才打开 |
| `AGY_BRIDGE_SYSTEM_APPEND` | 关闭 | 设为 `1` 把客户端的系统提示词附加到 agy 自己的系统提示词后面，而不是放进第一条提示词，见下文 |
| `AGY_BRIDGE_IDLE_MS` | 600000 | 进程空闲多久后回收（会话仍可续接） |
| `AGY_BRIDGE_SPARE` | 开启 | 每个账号预先启动一个备用 agy（只启动、不建会话，不发任何请求），新对话直接用它，省掉 agy 的启动时间；设为 `0` 关闭 |
| `AGY_BRIDGE_STATELESS_REUSE` | 开启 | 不流式、不带工具、只有一条消息的请求（识图、起标题），在已答完一个这类请求的空闲 agy 里新开会话，省掉 agy 首次建会话的几秒；那条旧对话再有下一轮时重放历史。设为 `0` 关闭 |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | 回收后的会话可续接的时长（6 小时） |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | 会话状态文件路径 |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | 工具运行超过该时间仍未结束时，先返回 "still running" |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 秒 / 5 分钟 / 30 分钟 | 进程启动、agy 无输出、等待客户端工具结果的超时 |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | 客户端已断开的挂起工具回合，最多占用进程池槽位这么久 |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688（112 KiB） | 一条提示词的字节预算（agy 会把一条提示词截在 128 KiB） |
| `AGY_BRIDGE_MAX_REPLAY_BYTES` | 模型窗口减去输出和 32K token，按每 token 2 字节算（插件不认识的模型为 384 KiB） | 新会话重放历史的字节预算，需要几条提示词就分几条发（agy 1.5.17 起）；超出的部分不发，并告诉模型 |
| `AGY_BRIDGE_SEED_REPLAY` | 开启 | 设为 `0` 时重放只发一条 `AGY_BRIDGE_MAX_PROMPT_BYTES` 大小的提示词，即 0.1.139 之前的做法 |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | 额度查询的总时间预算，最高 18000 |
| `AGY_BRIDGE_STORED_SIGNIN` | 未设置 | 设为 `skip` 时插件不读 agy 存的登录 |
| `AGY_BRIDGE_MCP_TRACE` | 未设置 | 把 MCP 通道流量写入指定文件，仅用于排查 |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | 插件启动的 agy 设为 `true` | agy 自己的变量。你设置了就原样传给 agy，见「环境要求」 |
| `AGY_BRIDGE_PREFILL` | 开启 | 设为 `0` 恢复对 assistant 预填尾巴的原生 400 拒绝，见「助手预填」 |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | 英文系统提示行 | 预填片段渲染时的提示行文本（发给模型） |

## 精简 agent（`AGY_BRIDGE_MINIMAL_AGENT=1`）

> **⚠️ 有封号风险，不建议开启。** 开启后，发往上游的请求不再带 agy 自己的系统提示词，和官方
> agy 客户端发出的请求不一样了；而这个插件的意义正在于请求由官方客户端发出、看起来就是官方客户端。
> 有用户反馈开启后几个小时账号就被封了。这只是一例反馈，不能证明就是它导致的，但请把这个风险当真。
> 开启时插件会在日志里打印一行同样的警告（每个进程一次）。已经开了的话，去掉这个变量即可恢复默认。

默认情况下，agy 用它自己的系统提示词跑每个请求，客户端的系统提示词作为
`<external_system_instructions>` 放在第一条提示词开头。Antigravity 对附加在 agy 系统提示词
后面的越来越多 agent 的提示词直接回 429（11-15 起包括 Claude Code 的 "You are an interactive
agent that helps users with software engineering tasks."，改成 "You're …" 也一样），只用 agy
自己的提示词时同一个账号能正常回答，所以默认不再用 agy 的 `systemPrompt.append`。设
`AGY_BRIDGE_SYSTEM_APPEND=1` 恢复以前的做法（agy 声明支持时附加到会话）。代价：客户端的系统
提示词和重放的历史共用同一个字节预算（`AGY_BRIDGE_MAX_REPLAY_BYTES`），agy 压缩上下文时
它也可能被概括掉。

Antigravity 对几行系统提示词（Claude Code 的计费行、Claude Agent SDK、Codex、Hermes Agent、OpenCode
和 pi 的身份句、oh-my-pi 的 RFC 2119 行）不论余量多少都回 429 "Resource has been exhausted"。插件在
agy 发出之前去掉计费那一行，其余几行换成同义的说法（"built on the Claude Agent SDK by Anthropic"、"built on GPT-5"、"RFC 2119 key words: …"、"You're Hermes Agent / OpenCode / a coding agent running in the Codex CLI"、"running within pi"），和 Antigravity 提供商的做法一样（`cloak.mjs`）。Codex 的两句 GPT-5 行（"You are Codex, a coding agent based on GPT-5"、"You are Codex, an agent based on GPT-5"）出现在用户的轮次里（AGENTS.md、`<system-reminder>`）也会被拒，所以用户轮次里也换成 "built on GPT-5"。零宽空格已经没用：11-14 起 Google 的检查会忽略它们。改写后放在第一条用户消息里（默认做法），Claude Code
的提示词能正常回答；放在 agy 的会话指令里（`AGY_BRIDGE_SYSTEM_APPEND=1`）仍然被拒。所以后者回的 429 报成针对
提示词的 400，前者报成限流，客户端可以重试，或交给别的账号。

DeepSeek Harness 的 `@` 路径说明段（"Tokens prefixed with @ are paths…"）也和 Antigravity 提供商一样
换成同义的说法再发：原文照发时 `gemini-4-argon` 大多很快答完、不思考、只走一步（#1028）。
DeepSeek Harness 的第一句 "You are an AI agent powered by DeepSeek Harness."（#1171）和它 Web GUI 段里的
"The browser provides no implicit DOM, route, or screenshot context."（#1105）原样发出也会被回 429，
分别改成 "You're …" 和 "The browser gives …" 再发。

设为 `1` 后，临时 agent 带上 `excludeDefaultComponents: true`：发往上游的请求里不再有
agy 自己的系统提示词，只剩插件的一行工具说明和客户端的系统提示词（同样以上面两种方式之一
发送）。原作者实测每次模型调用的输入从约 8,400 token 降到约 500 token。代价是上游看到的
不再是 agy 自己的请求形态，有封号风险（见本节开头），所以默认关闭，不建议开启。

## 常见排查

- **找不到 agy**：在 Magpie 里点 Sign in 让它装一份（需要 Magpie 0.1.4246 起），或设置 `AGY_PATH`
  指向可执行文件，或确认 `agy` 在 PATH 里。
- **Sign in 失败或 agy 报登录相关错误**：再点一次 Sign in 重新登录，或在终端运行一次 `agy` 登录。
- **"You do not have a valid license of this product" (#3501)**：这是 Google 拒绝了这个账号，
  终端里的 agy 本身也会这样答。插件会在 Providers 页的模型列表和请求的 HTTP 403 里写明这个原因，
  不再拿静态目录冒充账号的型号。可以试：升级 agy 后重新登录（Magpie 里点 Sign in，或终端运行
  `agy` 后 /logout 再 /login）；用个人 Google 账号（@gmail.com）而不是 Workspace 账号；如设置了
  `AGY_ADC_AUTH` 就去掉；关掉把你放到 Antigravity 未开放地区的 VPN 或代理。
- **HTTP 503**：进程池满。提高 `AGY_BRIDGE_MAX_PROCS` 和 Providers 页的 Concurrency，
  或者减少同时进行的会话。
- **额度显示 "Limits not available" 或报版本错误**：该窗口没有可测量的数据；版本错误则
  把 agy 升级到 1.1.11 以上。
- **图片请求返回 HTTP 400**：当前 agy 没有声明图片能力（需要 1.5.0 以上）。另外只接受
  内联 base64，URL 图片会被拒绝。
- **文档**：agy 只读文字和图片。文本文档（纯文本，或 base64 的文本/JSON/XML）按文字发过去；
  URL 文档发的是网址，由模型用工具去取。工具读到的 PDF 会变成一条说明，提示模型换个方式
  提取文字；直接附在消息里的 PDF 返回 HTTP 400 并说明原因，请改为粘贴文字或把页面作为图片附上。
- **回复里出现 "Agent execution terminated due to error."**：这是 agy 的错误标记。插件会
  从 agy 的日志中取出真实原因，并以错误结束本轮，不会当作正常回复输出。agy 1.5.8 的
  "There was a network issue connecting to the server" 和 "Your AI credits balance is
  too low to continue." 也一样（后者按额度不足报错）；`⚠ API error (attempt N)` 这类
  重试中的提示行会被去掉。agy 自己撞上输出上限后重试时，也会把三行提示写进正文
  （"Your previous response was cut off because it exceeded the output token limit"、
  它的续写指令和 "Retries remaining: N"），这三行同样会被去掉，后面模型的续写照常
  输出。agy 1.5.12 遇到格式错误的函数调用时重试的三行提示（"Your previous response
  contained an improperly formatted function call: …"、"Please retry with a properly
  formatted function call" 和 "Retries remaining: N"）也一样去掉；紧跟在另一条提示后的
  提示、额度或高负载结尾，以及回复开头被拆在两个分片里的提示，同样能认出。
  若结尾是 "This service has been disabled in this account for
  violation of Terms of Service"（agy 1.5.9 前面带 "PERMISSION_DENIED (code 403):"，1.5.10 不带），会按禁止重试的 403 语义 `permission_error` 返回，而不是
  当成正常正文。结尾是 "Verification Required"（Google 要求先验证这个账号）时也一样，
  并带上 agy 记下的验证链接；没有链接时说明去哪里验证。
  结尾是 "⚠ Individual quota reached. … Resets in 1h18m40s."（这个账号自己的额度用完）时，
  按额度不足（`rate_limit_error`，非流式为 HTTP 429）结束本轮，原文和重置时间一并带上，
  magpie 据此让这个账号歇到重置，并改问下一个账号。
  结尾是 "⚠ Third-party quota reached. Please switch to Gemini models … Resets in 3h22m19s."
  （这个账号 Claude 和 GPT-OSS 的额度用完，Gemini 的还在）时也一样结束本轮，magpie 让这个模型
  歇到重置，改问下一个账号或模型，这个账号的 Gemini 模型照常可用。
  结尾是 "⚠ Our servers are experiencing high traffic right now …"（Google 这个模型暂时没有
  余量，agy 的重试也都碰上了 503）时，按 `overloaded_error`（非流式为 HTTP 503）结束本轮，
  不让账号歇着，magpie 会再试或改问别处。（由 ifccod 发现并移植自他的补丁。）
- **回复只有思考、没有正文也没有工具调用**（billion-context 报 "the turn degenerated
  again after the continuation nudge"）：模型的一次回复空了时，agy 会写一行
  "⚠ Model produced invalid output." 并重试；重试也空时，agy 以正常结束收尾。插件不把这样
  的空结尾当作回复交出去，而是在同一个会话里再问一次（模型手上还是完整的上下文）；
  还是空的话以错误结束本轮，magpie 会改问下一个账号，客户端重发同一请求也会接着这个会话。
  一个连思考都没有的空结尾照常返回。
- **HTTP 409，提示工具结果与历史对不上**：通常是客户端在对话中途改写了历史或工具 ID。
  能确定对应关系时插件会重建会话；无法确定时直接拒绝，不做猜测。
  Hermes Agent 会把一次批量的 `tool_call({"calls": [...]})` 在自己的历史里拆成每项一次调用，
  插件会把它合回 agy 发出的那一次调用、那一份结果（#1150）。
- **想关掉思考摘要**：设置 `AGY_BRIDGE_THINKING=0`，或者在请求里带上
  `thinking: { "type": "disabled" }`。

## 开发

```sh
bun test packages/agy-cli        # 在仓库根目录
bun scripts/check.mjs agy-cli
```

测试用假的 agy 进程（`test/` 下的 ACP stdio 服务）跑完整的 ACP 与 MCP 链路，不调用真实
agy，不消耗额度。

## License

MIT。版权声明见 [LICENSE](LICENSE)，上游来源与逐项变更见 [NOTICE.md](NOTICE.md)。
