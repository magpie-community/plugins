# Code-Server Agent for Magpie

[![Tested with Bun](https://img.shields.io/badge/tested%20with-bun-black?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Magpie agent plugin for self-hosted [code-server](https://github.com/coder/code-server) (VS Code in the browser), enabling seamless integration with Magpie-managed AI models and gateways via the built-in GitHub Copilot Chat extension.

[中文说明](#中文说明) | [English](#english)

---

## English

### Overview

`magpie-agent-code-server` connects your self-hosted **code-server** instance to **Magpie**. It configures code-server's Copilot Chat extension to route inference requests through Magpie's unified gateway, letting you use any model configured in Magpie (Claude, OpenAI, Gemini, DeepSeek, Local LLMs, etc.) directly in code-server's chat interface.

### Features

- **Zero Runtime Dependencies**: Pure standard JavaScript / Bun implementation with custom zero-dependency JSONC parser.
- **Non-Destructive Configuration**: Preserves existing comments, trailing commas, indentation, and unrelated user settings in `settings.json` and `chatLanguageModels.json`.
- **Automatic Extension Adaptation**: Intelligently detects the installed GitHub Copilot Chat extension version in code-server and outputs the correct provider configuration (`customendpoint` for earlier versions, `customoai` for modern 0.24+ versions).
- **Multi-Profile Support**: Automatically discovers all VS Code profiles defined in `globalStorage/storage.json` and synchronizes settings across the default profile and all named profiles.
- **Atomic Rollback & Recovery**: Backs up the exact original settings before connecting and completely restores them upon disconnecting in Magpie or when the plugin host exits.
- **Accurate Gateway Attribution**: Requests are authenticated with dedicated credentials (`Bearer magpie-code-server`) so usage and statistics in Magpie are properly tracked as `code-server` rather than generic desktop VS Code.
- **Safe Signal Handling**: Integrates smoothly into Magpie's shared Bun plugin host without overriding global process signals (`SIGINT`/`SIGTERM`).

### Configuration Paths

By default, code-server stores user data under:
- `~/.local/share/code-server/User/settings.json`
- `~/.local/share/code-server/User/chatLanguageModels.json`
- `~/.local/share/code-server/User/profiles/*/`
- `~/.local/share/code-server/extensions/`

If you run code-server with a custom `--user-data-dir` or `--extensions-dir`, you can configure the environment variables:
- `CODE_SERVER_USER_DATA_DIR`: Override user data path.
- `CODE_SERVER_EXTENSIONS_DIR`: Override extensions directory.

The plugin stores intermediate bridge states in:
- `~/.config/magpie-code-server/connection.json`
- `~/.config/magpie-code-server/backup-state.json`

### Installation & Usage

1. **Install plugin in Magpie**:
   ```sh
   magpie plugin add github:sunriseydy/magpie-agent-code-server
   ```
   Or install locally from directory:
   ```sh
   magpie plugin add /path/to/magpie-agent-code-server
   # or run directly inside the directory:
   magpie plugin add .
   ```

2. **Connect in Magpie UI**:
   - Go to Magpie's **Agents** page.
   - Select **code-server** from the agent list.
   - Choose your preferred model and click **Connect**.

3. **Use in code-server**:
   - Open your code-server browser interface.
   - Open GitHub Copilot Chat (`Ctrl+Alt+I` / `Cmd+Alt+I` or click the Copilot icon in the activity bar).
   - Your Magpie model will be preselected and active.

4. **Disconnect**:
   - Click **Disconnect** in Magpie at any time to restore your previous code-server settings.

### Manual Recovery

If the plugin or system terminates unexpectedly before restoring configuration, you can view the snapshot in:
```sh
cat ~/.config/magpie-code-server/backup-state.json
```
Or simply remove the `"magpie-code-server"` provider entry from `~/.local/share/code-server/User/chatLanguageModels.json` and reset `"chat.defaultModel"` in `~/.local/share/code-server/User/settings.json`.

### Testing

Run unit tests:
```sh
bun test code-server.test.mjs
```

---

## 中文说明

### 概述

`magpie-agent-code-server` 是为自部署的 **code-server**（浏览器中的 VS Code）打造的 Magpie Agent 管理插件。它通过配置 code-server 内置的 GitHub Copilot Chat 扩展，将对话请求引导至 Magpie 网关，使您能够在 Web 端代码开发环境中无缝使用 Magpie 统一管理的任意大模型（如 Claude, OpenAI, Gemini, DeepSeek 或自建本地模型）。

### 核心特性

- **零外部依赖**：纯标准 JavaScript / Bun 原生实现，内置无损 JSONC 解析引擎。
- **无损配置修改**：修改 `settings.json` 与 `chatLanguageModels.json` 时保留所有用户原有注释、尾部逗号及个性化格式，不影响无关配置项。
- **扩展版本自适应**：自动扫描 code-server 插件目录中的 Copilot Chat 版本，智能适配对应的配置结构（早期的 `customendpoint` 或新版的 `customoai`）。
- **多 Profile 支持**：自动解析 `globalStorage/storage.json`，在默认配置与所有用户 Profile 之间同步模型配置。
- **原子备份与还原**：连接前自动生成备份快照 `~/.config/magpie-code-server/backup-state.json`，在 Magpie 中点击断开连接或插件退出时完全还原。
- **精准网关用量统计**：请求携带 `Bearer magpie-code-server` 凭据，Magpie 控制台统计图表中将准确归属为 `code-server`，与桌面版 VS Code 区分。
- **安全生命周期**：严格遵循 Magpie 插件规范，不抢占共享宿主进程的 `SIGINT`/`SIGTERM` 信号。

### 路径与环境变量

默认情况下，code-server 数据存放在：
- `~/.local/share/code-server/User/settings.json`
- `~/.local/share/code-server/User/chatLanguageModels.json`
- `~/.local/share/code-server/User/profiles/*/`
- `~/.local/share/code-server/extensions/`

如果 code-server 使用了自定义参数启动，可通过环境变量进行覆盖：
- `CODE_SERVER_USER_DATA_DIR`：指定用户数据目录。
- `CODE_SERVER_EXTENSIONS_DIR`：指定扩展安装目录。

### 安装与使用

1. **在 Magpie 中安装插件**：
   ```sh
   magpie plugin add github:sunriseydy/magpie-agent-code-server
   ```
   或直接使用本地目录路径添加（支持热修改调试）：
   ```sh
   magpie plugin add /path/to/magpie-agent-code-server
   # 或在插件根目录下直接执行：
   magpie plugin add .
   ```

2. **在 Magpie 界面中连接**：
   - 打开 Magpie 的 **Agents** 页面；
   - 在列表中选择 **code-server**；
   - 选择所需模型，点击 **Connect (连接)**。

3. **在 code-server 中使用**：
   - 访问 code-server Web 页面；
   - 打开 Copilot Chat 面板即可直接以 Magpie 模型进行对话与编程辅助。

4. **断开连接**：
   - 在 Magpie 中点击 **Disconnect (断开)**，所有配置自动还原到连接前的状态。

### 运行测试

```sh
bun test code-server.test.mjs
```

---

## 协议

[MIT License](LICENSE)
