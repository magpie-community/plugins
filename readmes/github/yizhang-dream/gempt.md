# GemPT v0.8.1

[English Quick Start & Docs](./README.en.md) · [Antigravity Plugin README](./plugin/README.md) · [Third-Party Licenses](./THIRD_PARTY_LICENSES.txt)

GemPT 让 Gemini 通过你的 [Magpie](https://github.com/yetone/magpie) 咨询所选下属模型、委派仓库任务，并在 **GemPT** 侧栏实时查看和介入运行。Magpie 插件、Antigravity stdio MCP、hooks、安装器和 CLI 共用一套 Node.js ESM 核心；运行时零第三方依赖（仅用 Node.js 内置模块），GemPT 随包提供预构建资源与完整第三方开源许可（[THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt)）。

## 前置依赖与版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| **Node.js** | `>= 22.13.0` | 运行 MCP server、hooks、CLI 与安装器 |
| **Magpie** | `>= 0.1.1340` | 本地网关（默认 `http://127.0.0.1:3425`），从 [yetone/magpie](https://github.com/yetone/magpie) / [usemagpie.ai](https://usemagpie.ai) 安装并登录 ChatGPT/Codex 订阅 |
| **Magpie 侧 GemPT 插件** | `0.8.1` | 提供 `Plugins → GemPT` 面板，并托管共享 Codex `app-server`（Windows 跨 Magpie 热重载独立存活，支持面板一键重启）；**仅单独安装 Codex CLI 无法替代** |
| **Codex CLI** | `@openai/codex`（已实测 `0.164.0`） | 仅 `gpt_run` 仓库执行需要；通过 `npm install -g @openai/codex` 安装（纯 `gpt_ask` 咨询可不装） |
| **Git** | 任意现代版本 | 仅并发隔离 `workspace="share"` 需要 |

## 从零安装与首次验证

### 1. 安装并登录 Magpie

安装 [Magpie](https://usemagpie.ai)（`>= 0.1.1340`），启动网关并在 Magpie 中接入至少一个对话模型。推荐 GPT，也可以选择其他提供商的模型。

### 2. 安装 Magpie 侧插件

直接在 Magpie 插件市场中搜索 **GemPT** 安装，或在终端运行：

```bash
# 推荐：从 GitHub tag 安装
magpie plugin add github:yizhang-dream/gempt#v0.8.1
```

> 注：`gempt` 尚未发布到 npm registry，请勿直接运行裸包名命令 `magpie plugin add gempt`（当前会返回 404）。

在 Magpie 左侧栏打开 **Plugins → GemPT**，确认网关连通后，点击 **启用模型配对**（或运行 `gempt init`）。

> Magpie 默认向其他接入客户端暴露 HTTP MCP（`http://127.0.0.1:3425/mcp/magpie/tools/gempt`），且默认 `exec: false`（仅允许 `gempt_ask`、只读 `gempt_run(access="inspect")` 与 `gempt_ctl`）。如需允许 HTTP 客户端执行写入，在 Magpie GemPT 插件选项中显式开启 `exec: true`。

### 3. 安装 Antigravity 侧插件

在 Magpie 的 **Plugins → GemPT → 概览 → 客户端接入** 展开 **启用 Antigravity 集成**。核对插件和命令目录后确认安装；受限内嵌页面会提供独立控制台链接和复制地址按钮。安装使用 Magpie 随包的版本，完成后在 Antigravity 打开新会话。只用 Magpie 的用户可跳过此步。

安装位置按运行 Magpie 的系统账户解析。若使用非标准目录，在 Magpie 的进程环境中设置 `GEMPT_AGY_PLUGIN_DIR`（GemPT 插件的完整目标目录）和可选的 `GEMPT_BIN_DIR`（命令目录），然后重启 Magpie。远程网关地址是单独的设置；如果 Antigravity 和 Magpie 不在同一机器，请在 Antigravity 所在机器执行下面的命令，并配置可访问的网关。

```bash
# 推荐：通过 GitHub tag 一键安装
npx --yes github:yizhang-dream/gempt#v0.8.1 install-agy
```

> 注：`gempt` 尚未发布到 npm registry，请使用上述 GitHub tag 渠道或从本地源码安装（裸 npm 命令 `npx --yes gempt@0.8.1 install-agy` 尚未生效）。

从本地源码安装时：
- **Linux / macOS**：`bash install.sh`（支持 `--target <目录>`）
- **Windows PowerShell**：`powershell -ExecutionPolicy Bypass -File .\install.ps1`（避免默认执行策略拦截）
- **构建可搬移 Marketplace 插件包**：`npm run build:agy-plugin`（默认输出自包含目录 `dist/agy-plugin/`，支持 `--out <目录>`，使用 `${PLUGIN_ROOT}` 与相对路径 hook）

安装器会将运行时、MCP 配置、hooks、规则、skills、图标与 Live 资源复制到 `~/.gemini/config/plugins/gempt`，并在 `~/bin` 写入 `gempt-wait` shim。若 `~/bin` 不在 `PATH` 中，将其加入 `PATH` 即可运行裸命令 `gempt-wait`，或始终直接执行 `gpt_run` 返回的完整 `wait_command`（内置绝对路径与跨平台引号后备）。

> **双装去重**：同时装了 Magpie 插件和 Antigravity 插件时，可在 Magpie GemPT 插件选项设置 `mcpTools: false`，让 Antigravity 走专属 stdio `gempt_gempt`，同时保留 Magpie 控制面板与共享 `app-server`。独立 stdio 客户端可用 `gempt print-mcp --installed` 导出配置。
>
> **常驻规则提示**：Antigravity 启用本插件期间，`rules/AGENTS.md` 会持续生效；在 Customizations 禁用插件即可同步停用。

### 4. 首次连通性验收

```bash
gempt discover
gempt init --non-interactive
```

随后在 Antigravity 中：
1. 首次咨询：调用 `gpt_ask(goal="Reply with OK")` 验证当前 Gemini 配对与 Magpie 网关连通。
2. 首次只读委派：调用 `gpt_run(goal="Inspect repository layout and report key files", cwd="<你的项目路径>", access="inspect")`，并按返回的 `wait_command` 后台等待唤醒。

### 从 Python 旧版升级

对原插件目录重新运行上述安装命令即可，无需 Python。旧目录存在 `work_split_hook.py` 时，安装器会自动生成兼容转发入口，让未重启的旧会话平滑过渡；共享配置与会话目录继续沿用。

## MCP 工具

| Antigravity stdio (`gempt_gempt`) | Magpie HTTP | 用途 |
| --- | --- | --- |
| `gpt_run` | `gempt_run` | 异步 Codex 仓库任务。传 `goal`、`cwd`，用 `access="inspect"` 只读调查或 `access="change"` 改代码。多路并发改同一 Git 仓库时传 `access="change"` + `workspace="share"`（基于已提交 `HEAD` 建独立 worktree；只读 `inspect` 禁止使用 `share`）。 |
| `gpt_ask` | `gempt_ask` | 同步咨询。传 `goal`，可选 `cwd`、`file_paths` 与 `session_id`。整理日志或摘要时传 `tier="chore"`。 |
| `gpt_ctl` | `gempt_ctl` | 状态查询、转向、中止或回复 `ask_gemini`（`action="status"|"steer"|"interrupt"|"reply"`）。在 Antigravity 打开 [GemPT](sidecar://gempt/gempt_live/) 侧栏，可切换至概览（含设置）、请求或会话。 |

`gpt_run` 返回 `run_id`、`session_id` 和 `wait_command`。请优先原样通过 `run_command(WaitMsBeforeAsync=500)` 后台执行返回的 `wait_command` 等待系统唤醒（终端手动等待可用 `gempt-wait <run_id>`、`gempt-wait id1,id2` 或 `gempt-wait --all id1,id2`）。续聊传 `session_id`；失败返工省略 `session_id` 开新线程。

新线程按 Antigravity 当前的 Gemini 家族配对，已知家族也可用 `gemini_family` 传入。回执用 `paired:<family>` 标识配对，用 `mcp` 标识未识别家族时走默认模型。旧脚本显式传入 `tier` 时仍按指定档位路由。

点击顶栏 **中 / EN** 可立即切换语言。打开 **概览 → 连接与高级设置** 可跟随浏览器语言、配置本地或远程 Magpie 网关、测试尚未保存的连接、调整模型与 Codex 选项，以及恢复默认设置。恢复默认时会默认保留当前网关。远程网关可使用保存的 API 密钥。若需从环境变量取密钥，请在 GemPT 进程环境中将 `GEMPT_TRUSTED_GATEWAY` 设为该网关的 Base URL。

## 控制面板

- **原生 Swarm 内核与工作台。** 用 `gpt_swarm` 分配工位，用 `gpt_board` 按频道通信。在 Swarm 工作台中用 Hive 查看成员、用 Mentions 追踪提及关系，可导出回放 GIF、管理频道，也可在 Raw 查看原始数据。
- **MCP 编排供 Antigravity 使用。** 在 `Plugins → GemPT` 为 Hydrogen、Neon、Carbon 选择当前 Magpie 网关列出的任意模型（含用户在 Magpie 自建的路由组 ID；仓库任务要求该模型支持 Responses 和工具调用），或选择「默认模型」以使用 Magpie 探测到的默认 Codex 订阅模型。面板同时提供思考强度、Swarm、执行权限和实际 Token 占比。工作分工有 `0%` 关闭、`15%` 重活提示、`35%` 源码写转 GPT、`60%` 加每回合 5 步核实止损，以及 `80%` 入口直派加 2 步核实。用 `/gempt` 编排任务，用 `/gempt-chore` 做摘要、压缩和分类。

## 命令行

```sh
gempt discover
gempt init --non-interactive
gempt sandbox workspace-write
gempt status --run-id <run_id> --wait
gempt prune-worktrees <repo_dir> --max-age-hours 168
gempt print-mcp --installed
```

`gempt prune-worktrees` 仅安全清理**无未提交改动且 `HEAD` 已合入主仓库**的闲置隔离 worktree，绝不删除未合并的工作成果。

## 权限、数据与安全边界

- **本地数据**：配置与会话默认位于 `~/.config/gempt/`（可用 `GEMPT_CONFIG`、`GEMPT_SESSIONS_DIR` 覆盖）。
- **工作区边界**：Antigravity stdio `gpt_run` 默认 `access="change"` 并沿用配置的 Codex 沙箱（推荐 `workspace-write`）。建议在外部/敏感环境中配置环境变量 `GEMPT_WORKSPACE_ROOT` 限定允许访问的根目录。
- **只读与 Worktree 隔离**：`access="inspect"` 严格禁止搭配 `workspace="share"`；`workspace="share"` 从已提交的 `HEAD` 检出（工作区未提交改动不会自动带入），创建时禁用目标仓库 Git hooks，并校验 worktree 归属。
- **回环鉴权**：Magpie 控制面板仅监听 `127.0.0.1:3498`，校验 Host/Origin、`x-gempt-key` 及本机身份文件；共享 Codex `app-server` 仅监听回环并启用 capability-token 认证。
- **Live 会话隔离**：GemPT 默认按当前绑定的宿主会话过滤（`scope="session"`），未绑定时默认不跨会话泄露历史运行，需显式切到 `scope="all"` 查看全部。

## 升级与卸载

- **升级**：在 Magpie 插件市场更新 **GemPT**（或重新运行 `magpie plugin add github:yizhang-dream/gempt#<新版本tag>`），并执行 `npx --yes github:yizhang-dream/gempt#<新版本tag> install-agy`。
- **卸载 Magpie 侧**：在 Magpie **Plugins** 页面移除 `gempt`，或执行 `magpie plugin remove gempt`。
- **卸载 Antigravity 侧**：在 Antigravity Customizations 卸载 `gempt` 插件（或删除 `~/.gemini/config/plugins/gempt`），并删除 `~/bin/gempt-wait*`。
- **清理个人配置（可选）**：删除 `~/.config/gempt/` 及本机隔离 worktree 目录（默认 `~/.cache/gempt-worktrees` 或 `%LOCALAPPDATA%\gempt-worktrees`）。

## 验证与开发

```sh
npm test
npm run build:agy-plugin
npm pack --dry-run
```
