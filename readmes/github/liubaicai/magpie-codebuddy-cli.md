<img src="assets/workbuddy.webp" alt="Codebuddy CLI" width="72" height="72">

# Codebuddy CLI

把本机的 **腾讯 CodeBuddy CLI** 接入 [Magpie](https://github.com/yetone/magpie)，在同一个网关中使用 CodeBuddy 账号的模型、思考过程和工具调用。

模型推理由真正的 `codebuddy --acp` 进程完成。插件负责账号注入、协议转换和会话管理；登录与积分查询使用 CodeBuddy 账号接口。无需另行配置模型服务商的 API key。

- 展示名：**Codebuddy CLI**
- Provider ID：`codebuddy-cli`
- 当前发布：**v0.1.7**
- 安装源：本 GitHub 仓库，**不是 npm 安装地址**

这是独立社区项目，与腾讯、CodeBuddy、WorkBuddy 官方无隶属关系。来源、授权和 logo 说明见 [NOTICE.md](NOTICE.md)。

## 目录

- [快速开始](#快速开始)
- [安装、升级与卸载](#安装升级与卸载)
- [账号与余额](#账号与余额)
- [模型、思考与推理强度](#模型思考与推理强度)
- [工具调用与工作目录](#工具调用与工作目录)
- [会话、并发与超时](#会话并发与超时)
- [支持范围与限制](#支持范围与限制)
- [环境变量](#环境变量)
- [常见问题](#常见问题)
- [开发与验证](#开发与验证)

## 快速开始

### 1. 准备环境

需要：

- 支持 OpenCode 风格 Provider 插件和 GitHub 插件安装的 Magpie。
- Node.js **22 或更新版本**。
- 支持 `--acp --acp-transport stdio` 的 CodeBuddy CLI。
- 能连接 GitHub、CodeBuddy 登录和模型服务的网络环境。

安装并检查 CodeBuddy CLI：

```sh
npm install -g @tencent-ai/codebuddy-code
codebuddy --version
```

Magpie 管理自己的插件运行时，不需要单独安装 Bun。CLI 必须安装在 **运行 Magpie 的机器** 上；只安装在远端客户端机器上无效。

协议行为核验基线为 CodeBuddy CLI **2.181.0**、Magpie **0.1.3492**。代码兼容 Windows、macOS 和 Linux 的启动方式，实际平台验证范围见[开发与验证](#开发与验证)。

### 2. 安装插件

推荐安装已发布的固定版本：

```sh
magpie plugin add github:liubaicai/magpie-codebuddy-cli#v0.1.7
```

也可以在 Magpie 的插件添加入口中粘贴：

```text
github:liubaicai/magpie-codebuddy-cli#v0.1.7
```

安装后显示为 **Codebuddy CLI**，带有随包内置的 logo，不需要联网下载图标。

### 3. 添加 CodeBuddy 账号

1. 打开 Magpie 的 Providers 页面，找到 **Codebuddy CLI**。
2. 选择 **Sign in with CodeBuddy**，在打开的官方页面完成授权。
3. 等待 Magpie 显示账号和模型列表。
4. 需要第二个账号时，再次发起登录；每次成功授权保存为独立账号。

不需要先在终端执行 `/login`。无法完成浏览器流程时，可以选择 **Paste an access token**，填入自己有权使用的 CodeBuddy access token。

### 4. 在客户端选择模型

让客户端连接 Magpie 的网关地址和调用密钥，然后从同步的模型列表中选择：

```text
codebuddy-cli/hy3
codebuddy-cli/deepseek-v4.1-flash
codebuddy-cli/glm-5.3
```

这些是常见示例，不保证每个账号都可用。实际模型 ID、上下文窗口、图片能力和推理档位以该账号的 ACP 目录为准。目录未加载或暂时无法探测时，插件可能先显示占位模型；占位列表不代表账号已获得相应模型权限。

## 安装、升级与卸载

### 跟踪默认分支

希望后续直接获取默认分支更新时，可以安装：

```sh
magpie plugin add github:liubaicai/magpie-codebuddy-cli
```

固定标签安装不会自动变成下一个标签。升级固定版本时，将安装命令中的版本替换为目标发布标签后重新添加。跟踪分支安装可使用 Magpie 插件页面的更新操作。

`magpie plugin update` 会更新已安装的多个插件，不是仅更新本插件。

### 版本与下载

- [所有发布版本](https://github.com/liubaicai/magpie-codebuddy-cli/releases)
- [v0.1.7](https://github.com/liubaicai/magpie-codebuddy-cli/releases/tag/v0.1.7)
- [更新记录](CHANGELOG.md)

每个本次发布的附件包含 npm 格式 `.tgz` 安装包和 SHA-256 校验文件。直接在 Magpie 安装时使用上面的 `github:` 地址即可，无需自行解压。

包内保留 `@magpie-community/opencode-codebuddy-cli-auth` 作为兼容标识，不表示该版本已发布到这个 npm 命名空间，也不表示已加入 Magpie 社区市场。

### 临时停用或卸载

可以在 Magpie 插件页面停用、启用或移除本插件。命令行先查看实际识别到的插件名称：

```sh
magpie plugin list
```

再使用列表中的名称执行 `magpie plugin off <name>` 或 `magpie plugin rm <name>`。要删除账号，请在 Providers 页面管理对应的授权，不要把卸载插件当作清除凭据的方式。

## 账号与余额

### 多账号隔离

Magpie 保存各账号的凭据并决定本次请求使用哪个账号。插件在每次请求时重新读取该账号的授权：

- 不同账号不共用 CodeBuddy 进程。
- 账号凭据缺失、无效或读取失败时返回 **401**，不会悄悄改用机器默认身份。
- 模型目录按账号缓存，同一账号的并发目录刷新会合并。
- token 过期后，需要在 Magpie 中重新授权对应账号；插件不实现 token 刷新。
- 多个浏览器登录流程按 OAuth state 独立管理，不会因第二次登录而取消第一次。

只有调用方 **没有提供账号回调** 时，才允许使用 CLI 自身登录或 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_AUTH_TOKEN_FILE`。在 Magpie 中管理的账号不会因读取失败而使用这些默认身份。

### 账号与模型路由

`smart`、`order`、`rotate` 等账号选择策略由 Magpie 提供；插件负责按最终选中的身份执行请求。路由算法、刷新周期和可选策略以 Magpie 当前版本为准。

多个模型之间的路由可以使用 Magpie 的路由组，例如：

```sh
magpie group add codebuddy-pool models=codebuddy-cli/hy3,codebuddy-cli/deepseek-v4.1-flash routing=rotate
```

客户端选择 `group/codebuddy-pool` 即可。组内应仅包含账号实际可用的模型。

### 积分余额

在 Magpie 的账号用量中刷新，或执行：

```sh
magpie quota codebuddy-cli
magpie quota codebuddy-cli --json
```

余额查询使用该账号自己的授权，读取 CodeBuddy 中国区积分资源接口，不启动 CLI，也不发起模型推理。有效套餐与赠送资源按接口的精确字段汇总，未生效和已过期的资源不计入余额。

查询失败、分页不完整或授权失效会显示错误，不会伪装成零余额，也不会换用其他账号。当前浏览器登录和积分实现面向 CodeBuddy 中国区，不承诺 WorkBuddy AI 等其他站点的账号接口兼容。

## 模型、思考与推理强度

### 思考过程

| 请求方式 | 输出行为 |
|---|---|
| `thinking.type = "enabled"` 或 `"adaptive"` | 以独立的 `thinking` 块流式返回 |
| `thinking.type = "disabled"` | 不转发思考内容，只返回回答 |
| 未指定 `thinking` | 将 CLI 提供的思考内容并入正文，避免客户端过滤后看不到进展 |

`disabled` 控制思考内容的转发，不保证关闭模型服务端的推理计算。

默认启用 Magpie 思考缓冲兼容：流式响应首次收到真实思考、此前尚未输出正文时，先发送一个仅含 **一个 ASCII 空格** 的正文块，再持续发送思考。空字符串和 ping 无法触发 Magpie 0.1.3492 的放行逻辑。每个响应最多添加一次，非流式回复不添加，空格不计入模型输出用量。

需要关闭时设置：

```text
CODEBUDDY_BRIDGE_THINKING_LEAD=0
```

思考一旦交付给客户端，网关就不能再完全隐藏这次输出后重试；后续错误按已开始的流处理。具体切换行为取决于 Magpie。

### 推理强度

优先读取显式档位：

- `output_config.effort`
- `reasoning_effort`
- `reasoning.effort`

未指定显式档位时，才将 `thinking.budget_tokens` 映射为档位。最终通过 `--effort` 传给 CLI；会根据账户目录提供的档位选择最接近的受支持值。

支持的档位来自 CLI，不是所有模型都有相同选项。账号、模型或档位变化时，不复用不匹配的进程。接口中的 `max_tokens` 与目录输出预算不构成 CLI 的严格生成长度保证。

### Anthropic Messages 请求示例

以下是 Bash 示例。网关地址和密钥以 Magpie 设置页为准，`MAGPIE_API_KEY` 是 **Magpie 调用密钥**，不是 CodeBuddy token：

```bash
export MAGPIE_API_KEY='替换为你的 Magpie 调用密钥'
curl -N http://127.0.0.1:3425/v1/messages \
  -H "Authorization: Bearer $MAGPIE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "codebuddy-cli/deepseek-v4.1-flash",
    "stream": true,
    "max_tokens": 32768,
    "thinking": {"type": "enabled", "budget_tokens": 16384},
    "output_config": {"effort": "high"},
    "messages": [{"role": "user", "content": "解释一下 ACP 与 MCP 的分工。"}]
  }'
```

其他协议由 Magpie 转换；插件接收的是 Anthropic Messages 格式，不是通用 HTTP 代理。

## 工具调用与工作目录

客户端声明的工具由插件转换为一个监听本机回环地址的 HTTP MCP 服务，CLI 通过它调用客户端工具：

```text
客户端请求 → Magpie → 插件 → CodeBuddy CLI（ACP）
                            ↕ HTTP MCP
客户端执行工具 ← tool_use / tool_result
```

工具请求带有随机令牌，插件校验令牌与路径；调用记录按插件实例和会话隔离。

### 两类工具

| 工具 | 执行位置 | 默认行为 |
|---|---|---|
| 客户端声明的 MCP 工具 | 客户端 | 通过工具轮调用并回传结果 |
| CodeBuddy 原生 Bash、Read、Edit、Write 等 | **运行 Magpie 的宿主机** | 允许，由 CLI 执行 |

原生工具的工作目录是插件宿主的 `process.cwd()`，**不保证是客户端项目目录**。远端客户端尤其要区分这两个位置。

希望操作只通过客户端工具时，设置 `CODEBUDDY_BRIDGE_NATIVE_TOOLS=0`，不要同时开启 `CODEBUDDY_BRIDGE_SKIP_PERMISSIONS`。CLI 可能将原生工具拒绝视为本轮取消，不能保证它一定改用客户端工具。

插件只为会话显式提供自己的 MCP 服务，未强制 `--strict-mcp-config`。CLI 如何加载自身配置和其他 MCP 服务由 CLI 决定，本插件不提供完整配置隔离承诺。

### 慢工具与迟到结果

工具迟迟未完成时，`CODEBUDDY_BRIDGE_TOOL_DEADLINE_MS`（默认 150 秒）会先向 CLI 返回 `still running` 占位结果。客户端的真实结果到达后，等原 prompt 结束，再串行提交给同一会话；旧结束事件不会提前截断真实结果的回复。

每次 `tool_use` 响应结束后，插件最多等待 `CODEBUDDY_BRIDGE_TOOL_TIMEOUT_MS`（默认 30 分钟）的有效续接。超时会清理该轮工具记录、关闭 CLI 并释放槽位；错误工具 ID 不延长时限。有效续接会取消计时器。

插件不能替客户端保证任意重试、改写历史或进程重启下的工具副作用“恰好一次”。涉及写入、支付或外部提交的工具应由客户端自行处理幂等。

## 会话、并发与超时

- 同一账号、模型、推理档位、系统指令和工具配置下，历史一致的后续轮可以复用活会话。
- 改写历史、变更工具 schema、切换账号或进程被回收后，会使用请求中的历史重新建立上下文。
- 池有空余时，后台最多保留一个匹配配置的备用进程。
- 活会话、备用进程、目录探测，以及启动中、停止中的 CLI **共用同一进程上限**，默认每插件实例 8 个。
- 同一对话的并发请求排队等待；全池容量不足且无空闲进程可回收时返回 503。

Magpie 的 Provider Concurrency 和本插件的进程上限是两处设置，可以按机器资源协调。提高请求并发不等于提高 CLI 进程上限。

**模型任务没有固定总时长限制。** `CODEBUDDY_BRIDGE_TURN_IDLE_MS` 按无事件进展的时长判定卡住；持续有进展不会仅因总耗时变长而被终止。等待客户端工具结果的计时器只在没有响应流读取者的续接阶段工作，不限制续接后的活跃任务。

## 支持范围与限制

| 项目 | 支持情况 |
|---|---|
| 文字请求、流式与非流式回复 | 支持 |
| system/developer 文字指令 | 按消息顺序合并为客户端指令；非文字指令明确报错 |
| 图片 | 当前轮支持内联 base64 PNG、JPEG、GIF、WebP，还需模型声明图片能力 |
| 文字文档 | 支持 text 源，以及 base64 的 `text/plain`、`text/markdown` |
| PDF、音频、视频及远程图片 URL | 不作为这些媒体的原生输入支持；不支持的输入会报错 |
| 模型目录与可用能力 | 来自账号的 ACP 元数据，失败时可能使用缓存或占位目录 |
| 会话持久化 | 活进程内保留，不保证 Magpie/CLI 重启后恢复原生会话 |
| OpenCode 兼容入口 | 包含 1.x / 2.x 适配入口；经 Magpie 使用时，客户端无需另装本插件 |

新进程的历史重放是文字转录，不等同于原生完整会话恢复。转录总预算约 96 Ki 字符；工具参数、工具结果和文档片段有约 8 Ki 字符的单项裁剪。更早内容可能省略，历史图片只保留占位描述。需要再次分析图片时请重新发送图片。

原生 Windows 使用 Node 入口解析 npm shim，启动 CLI 不经 `cmd.exe`。macOS/Linux 使用独立进程组；取消和回收时会处理该组。CLI 协议及账号服务行为可能随版本变化，遇到兼容问题请提交版本与脱敏错误信息。

## 环境变量

环境变量必须对 **Magpie 宿主进程** 可见。终端里设置变量不会改变已经运行的桌面 Magpie；改动后需重新启动对应宿主。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEBUDDY_PATH` / `CODEBUDDY_BIN` | PATH 查找 | 指定 CLI 入口。`CODEBUDDY_PATH` 优先；显式路径不可用时直接报错，不另找其他 CLI |
| `CODEBUDDY_BRIDGE_MAX_PROCS` | `8` | 每个插件实例的 CLI 进程总上限 |
| `CODEBUDDY_BRIDGE_IDLE_MS` | `600000` | 空闲进程回收时限，单位毫秒 |
| `CODEBUDDY_BRIDGE_QUEUE_MS` | `300000` | 同一对话排队时限，超时返回 503 |
| `CODEBUDDY_BRIDGE_FIRST_EVENT_MS` | `2500` | 流开始前检查早期错误的等待窗口，不是任务超时 |
| `CODEBUDDY_BRIDGE_THINKING_LEAD` | 开启 | 首个真实思考前发送空格正文，设 `0` 关闭 |
| `CODEBUDDY_BRIDGE_START_TIMEOUT_MS` | 正常会话 `90000`；目录探测 `45000` | 进程启动、ACP 握手的超时 |
| `CODEBUDDY_BRIDGE_TURN_IDLE_MS` | `600000` | 活跃响应中无事件进展的最长时间 |
| `CODEBUDDY_BRIDGE_TOOL_DEADLINE_MS` | `150000` | MCP 工具未完成时发送占位结果的等待时间 |
| `CODEBUDDY_BRIDGE_TOOL_TIMEOUT_MS` | `1800000` | 每次工具响应后等待有效客户端续接的时限 |
| `CODEBUDDY_BRIDGE_CATALOG_TTL_MS` | `300000` | 模型目录缓存时长 |
| `CODEBUDDY_BRIDGE_NATIVE_TOOLS` | 开启 | 设 `0` 拒绝 CodeBuddy 原生工具 |
| `CODEBUDDY_BRIDGE_SKIP_PERMISSIONS` | 关闭 | 设 `1` 添加 `--dangerously-skip-permissions`，仅用于明确可信的环境 |
| `CODEBUDDY_AUTH_TOKEN` | 未设置 | 无账号回调时的默认 token |
| `CODEBUDDY_AUTH_TOKEN_FILE` | 未设置 | 同上，读取裸 token 或含 `accessToken` / `auth.accessToken` 的 JSON |
| `CODEBUDDY_CLI_DISABLE_AUTO_UPDATE` | 未设置时注入 `true` | 使用 CLI 自身的自动更新控制变量；显式配置优先 |

`CODEBUDDY_PATH` 优先于 `CODEBUDDY_BIN`。示例：

```powershell
$env:CODEBUDDY_PATH = 'C:\Users\your-name\AppData\Roaming\npm\codebuddy.cmd'
$env:CODEBUDDY_BRIDGE_MAX_PROCS = '4'
# 从这个环境启动 Magpie；已运行的实例需先退出。
```

```bash
export CODEBUDDY_PATH='/usr/local/bin/codebuddy'
export CODEBUDDY_BRIDGE_MAX_PROCS=4
# 从这个环境启动 Magpie；已运行的实例需先退出。
```

默认 token 的优先级为 `CODEBUDDY_AUTH_TOKEN`、token 文件、CLI 自身登录。token 文件会在读取默认凭据时重新读取，便于外部续期；使用 Magpie 账号回调时仍以账号凭据为准。

## 常见问题

| 现象 | 排查方法 |
|---|---|
| 找不到 CLI / 启动失败 | 确认 CLI 安装在 Magpie 宿主机，检查 `codebuddy --version`，必要时设置 `CODEBUDDY_PATH`。桌面程序可能未继承终端 PATH |
| 401 / 授权不可读 | 在 Magpie 中重新授权报错的账号。只在终端 `/login` 不会替换 Magpie 已保存的账号 token |
| 409 / 工具结果不匹配 | 检查工具 ID、账号、模型、工具 schema 和历史。超时前可补正确结果；状态已失效时从自洽历史重新开始，不要反复发送错误结果 |
| 503 | 区分同一对话仍在执行、排队超时和全池无空闲槽位。持续输出的任务应等待；被放弃的工具轮会按续接时限回收。资源允许时再提高并发和进程上限 |
| 没看到思考 | 检查客户端是否请求并显示 thinking；确认未禁用空格兼容措施。CLI 首次启动和模型本身的等待仍会影响首片耗时 |
| 工具没有执行 | 确认客户端发送了工具定义和工具结果，区分客户端工具与宿主原生工具；不能保证模型每轮都会调用工具 |
| 图片或文档失败 | 图片需内联且模型支持；PDF、音视频不能按原生媒体转发，文字文档支持范围见上表 |
| 余额查询报错 | 检查该账号授权与账号服务连接。不会自动改用其他账号或显示假零余额 |
| 固定版本更新后仍是旧版 | 检查安装源是否仍固定旧标签；在插件页确认版本，按新的发布标签重新安装 |

问题反馈请使用 [GitHub Issues](https://github.com/liubaicai/magpie-codebuddy-cli/issues)，提供插件、Magpie、CLI、Node 和操作系统版本，以及脱敏后的错误、复现步骤。不要提交 token、Magpie 调用密钥或完整账号凭据文件。

## 开发与验证

项目无运行时 npm 依赖。克隆后可直接运行测试：

```sh
git clone https://github.com/liubaicai/magpie-codebuddy-cli.git
cd magpie-codebuddy-cli
node --test --test-skip-pattern 'real CodeBuddy CLI' test/*.test.mjs
```

不加筛选的 `npm test` 在已安装 CLI 时会额外执行可选的 `--version` 检查，不发起模型推理。协议回归使用假的 ACP/MCP 进程，不消耗模型额度。发布前在 Windows 上核验；POSIX 专属用例在 Windows 上跳过，不能据此宣称已经做过 macOS/Linux 实机验证。

```sh
npm pack --dry-run
npm pack
```

入口与主要文件：

| 文件 | 用途 |
|---|---|
| `index.mjs` | Provider、账号接入、目录、Messages 流与工具轮 |
| `acp.mjs` | ACP stdio 协议与 CLI 生命周期 |
| `session-pool.mjs` | 统一进程容量、复用、排队、预热和回收 |
| `translate.mjs` | 请求、历史、图片、文档、思考和用量转换 |
| `accounts.mjs` / `credits.mjs` | 登录与按账号查询积分 |
| `mcp-bridge.mjs` / `platform.mjs` | 本地工具桥接与跨平台启动 |
| `opencode.mjs` / `opencode2.mjs` | 1.x 入口与上游 2.x 适配器快照 |
| `diagnostics/` | 故障分析、流式时序与历史审查记录 |

`diagnostics/stream-timing.mjs` 是显式的真实模型诊断，会读取本机 Magpie 账号并消耗模型额度；它不属于默认测试。`diagnostics/session-timing.mjs` 用于本地会话轨迹分析。历史诊断记录描述当时版本，不应当作当前性能承诺。

## License

代码以 [MIT License](LICENSE) 发布。共享适配器来源及第三方产品标识说明见 [NOTICE.md](NOTICE.md)。
