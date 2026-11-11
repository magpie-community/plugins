# Magpie Agent for Rambo

这个插件把 Magpie 选中的模型和网关地址写入 Rambo 的标准 Codex 配置，并把专属访问密钥放入 Magpie 私有的凭据文件，由 Codex command-backed auth 读取。Rambo 只读取自己的 `codex-home/config.toml`；适配和写入由本插件完成。

插件不会把提示词、聊天记录、Skills、MCP 配置或其他资源同步到 Magpie。请求正文会按模型请求正常经过 Magpie 网关。

## 安装

仓库带有 GitHub `magpie-plugin` topic，可在 Magpie 的 Plugins → Discover → Unofficial 中发现。macOS 用户可以直接添加仓库：

```sh
magpie plugin add ./magpie-agent-rambo
```

克隆仓库后，Windows 用户使用平台对应的 Agent 文件：

```sh
magpie plugin add ./magpie-agent-rambo/agents/rambo-windows.mjs
```

Linux 用户（社区构建）使用：

```sh
magpie plugin add ./magpie-agent-rambo/agents/rambo-linux.mjs
```

Magpie 先把 Agent 连接状态写到自己的私有目录，再由插件的 Bun `main` 模块轮询并同步到 Rambo：

- macOS 目标：`~/Library/Application Support/Rambo/codex-home/config.toml`
- Windows 目标：`%APPDATA%/Rambo/codex-home/config.toml`
- Linux 目标：`~/.config/Rambo/codex-home/config.toml`

安装后在 Magpie 的 Agents 页面为 Rambo 选择模型。插件写入配置后重启 Rambo 生效；更换模型或在 Magpie 中断开后，也需要重启 Rambo。

插件同时读取网关的 `/v1/models`，生成 Codex 兼容的模型目录，并通过标准 `model_catalog_json` 让 Rambo 的模型下拉显示 Magpie 当前凭据可见的模型。网关返回的 OpenAI `/v1/models` 格式不会直接写入 Codex 目录；插件会补齐 Codex 所需的模型元数据。Rambo 仍只读取自己的标准 Codex 配置。

## 本机识别与连接

Magpie 读取插件中对应平台的 Agent 描述，按 `dir` 检查本机是否装有 Rambo，并在列表中显示检测结果。macOS 使用 `/Applications/Rambo.app`；Windows 使用 `%LOCALAPPDATA%/Programs/Rambo`；Linux 使用 `~/.config/Rambo`。插件只声明 Rambo 的实际安装位置和启动约定，不附带或启动自己的 Rambo 副本。

接入模型时，Magpie 把当前模型、网关地址、访问密钥和管理标记写入 `~/.config/magpie/agent-state/rambo/bridge.json`。插件 Bun `main` 模块轮询该文件，只合并 Rambo `config.toml` 中归 Magpie 所有的字段。断开后只恢复这些字段，连接期间由 Rambo 或其他工具改动的无关配置和注释保持不变。

## 配置与凭证

桥接文件由 Magpie 管理，包含 `model`、`baseURL`、`apiKey` 和 `managedBy` 字段。`apiKey` 是 Magpie 网关为 Rambo Agent 生成的访问密钥。插件把非敏感 Provider 配置写入标准 Codex TOML，并把密钥写入 Magpie 私有状态目录中权限为 `0600` 的 token 文件。Codex 通过以下 command-backed auth 读取该文件：

```toml
[model_providers.magpie]
name = "Magpie"
base_url = "http://127.0.0.1:3425/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.magpie.auth]
command = "/bin/cat"
args = ["/path/to/magpie/agent-state/rambo/token"]
timeout_ms = 5000
refresh_interval_ms = 0
```

Windows 使用 `cmd.exe /d /c type <token-path>`。密钥不会进入 Rambo 的 TOML、数据库或聊天记录。

模型目录示例：

```toml
model = "codex/gpt-6-luna"
model_provider = "magpie"
model_catalog_json = "/Users/you/.config/magpie/agent-state/rambo/models.json"
```

禁用或断开 Magpie Agent 后，插件只恢复连接前归它所有的顶层 `model`、`model_provider`、`model_catalog_json` 和 `[model_providers.magpie]` 字段，并删除自己生成的模型目录，不会用旧快照覆盖其他配置。Rambo 始终只读取标准 `codex-home/config.toml`，不认识 `magpie.json`、桥接路径或 Magpie 专属状态。重启 Rambo 后，原模型来源恢复。

## 开发

```sh
npm test
```

GitHub 发现使用 `magpie-plugin` topic。插件发现卡片使用 `package.json` 中自包含的 SVG `magpie.icon`，圆角由 SVG 形状裁切。Agent 文件保持 Magpie 脚本引擎可直接读取的静态描述，并为 Agent 列表提供带透明圆角的版本化 PNG 图标；插件不在 Agent 文件中使用 `URL`、`import.meta` 或其他 Node.js 专有全局。文件同步逻辑位于 Bun `main`，不进入 MoeJS Agent 文件。
