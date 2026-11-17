# Cursor · Magpie 智能桥接 / Cursor · Magpie Bridge

[English](#english) | [简体中文](#简体中文)

---

<a name="简体中文"></a>
## 🇨🇳 简体中文

> 让 **Cursor** 能够直接无缝使用 **Magpie** 网关代理中的任意大模型（GPT-6.1-Sol / Claude 3.7 / Gemini 2.5 / DeepSeek 等），具备全平台自适应路径、超高前缀缓存命中率、智能 Tab 代码补全、子代理（Subagent）深度调度、便携式绿色数据库以及全自动免重启热切换能力。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64%20%7C%20macOS-green.svg)]()
[![Cursor Version](https://img.shields.io/badge/Cursor-3.28%20~%203.30+-orange.svg)]()

---

### 🌟 核心特性

- ⚡ **无头独立高性能引擎**：基于 Rust 原生开发，内置 MITM 代理、Connect-RPC / Protobuf 协议转码器与嵌入式 SQLite 引擎，无需任何庞大外部依赖。
- 🚫 **彻底隐藏 Cursor 默认 Auto 开关**：
  - 协议层下发 `ModelPickerDisplayConfiguration`（`hide_routed_model_view = true` 与 `NoAutoButton {}`），彻底抹平 Cursor 界面右下角 Auto 控件；
  - 根除 Cursor 启动后自动重置为 Auto 导致模型匹配失效的问题；引擎全链路兜底接管 `auto` 与 `default` 请求并平滑回退至本地首选模型。
- 🏷️ **模型名称智能短名化（Short Model Name）**：
  - 针对多段冗长模型全称自动截取首段关键简称为短名，消除 Cursor 模型下拉列表中的排版截断。
- 🧪 **控制台模型列表与连通性测速**：
  - 控制台内嵌生效模型列表面板，每个模型配备专属「测试」按钮；
  - 点击向 Magpie 网关实时发送 8-token 超轻量探测，毫秒级反馈实际延迟（如 `🟢 168ms`）或精准错误详情；支持搜索过滤与「一键测全部」。
- 🩺 **控制台内嵌「日志查看器与一键全项自检」**：
  - 网页内直接翻阅 `engine.log`、`supervisor.log` 与 `supervisor-error.log` 最新 80 行内容，免翻找系统文件夹；
  - 一键运行系统体检，涵盖「控制服务」、「原生代理引擎」、「CA 根证书」、「SQLite 数据库」及「Magpie 网关模型」5 大关键指标。
- ⌨️ **Cursor Tab 智能代码补全（双模加速）**：
  - **官方 Token 极速模式（推荐）**：支持 16 个上游端点精准分流（`StreamCpp`, `FSSyncFile`, `RecordCppFate` 等）与动态 Checksum 毫秒级极速加速；控制台提供“一键提取本机登录 Token”。
  - **Magpie 模型补全模式**：可将 Tab 代码补全请求定向调度至在 Magpie 接入的任意代码模型（如 DeepSeek、GPT-6.1-Sol 等）。
  - **多样模式切换**：支持直连官方、自定义服务端点及公共服务模式。
- 🤖 **子代理（Subagent / Task）深度调度**：
  - 完整兼容 Cursor Agent 模式的 `Task` 工具调用；
  - **智能模型继承**：子代理自动继承当前父会话的模型，无需重复指定；
  - **双运行模式**：
    - **异步后台（默认推荐）**：子代理后台并行运行，完成后由桥接唤醒父代理整合结果；
    - **同步阻塞模式**：强制 Task 以 `run_in_background=false` 执行，父代理原地等待子代理返回。
- 🎯 **超高前缀缓存命中率（KV Cache）**：
  - 内置完整的 Checkpoint 增量指纹维持算法；
  - 在大上下文、多轮长对话及指令场景下稳定维持 **49%+ 的缓存命中率**，极大降低 Token 消耗并显著缩减首字响应时间（TTFB）。
- 💾 **真正的绿色便携存储与数据目录热迁移**：
  - 支持跨盘（如 E 盘、D 盘、移动硬盘或 U 盘）任意存放数据目录；
  - 控制台内嵌“存储迁移/切换”能力：输入任意目标路径，空目录自动复制现有数据，已有数据目录直接安全秒级挂载；
  - 无缝兼容 `cursor-byok.db` 与 `bridge.db`，可直接继承原有历史会话与缓存记录。
- 📊 **可视化控制台与数据库维护**：
  - 直读 SQLite 分析，按会话、检查点、运行记录、调用日志、Blob 结构化展示存储占用与时间分布；
  - 支持清理调用追踪、按天数清理旧会话、仅压缩数据库（VACUUM 回收磁盘碎片）与清空运行数据。
- 🔄 **日常使用 100% 免重启 Cursor**：
  - 代理端口恒定为 `http://127.0.0.1:45678`；模型切换、Tab 补全模式变更均在代理内部秒级热切换，对 Cursor 客户端完全无感，无需反复退出或重启软件。

---

### 🏗️ 架构与运行原理

```text
┌──────────────┐          Protobuf / Connect-RPC           ┌────────────────────────────────────────┐
│              │ ────────────────────────────────────────> │                                        │
│    Cursor    │                                           │      cursor-magpie-bridge (Rust)       │
│  (IDE 客户端) │ <──────────────────────────────────────── │  • MITM 代理拦截 (127.0.0.1:45678)     │
└──────────────┘           流式回复 / 思考 / 工具调用 / Tab     │  • Checkpoint 前缀增量缓存树 (KV)       │
                                                           │  • 16 端点 Tab 分流与动态 Checksum     │
                                                           │  • Portable SQLite (bridge.db)         │
                                                           └───────────────────┬────────────────────┘
                                                                               │
                                                                               │ HTTP / SSE (OpenAI 兼容)
                                                                               ▼
                                                           ┌────────────────────────────────────────┐
                                                           │             Magpie Gateway             │
                                                           │         (http://127.0.0.1:3425)        │
                                                           └────────────────────────────────────────┘
```

1. **流量拦截**：Cursor 发送给官方 API（`api2.cursor.sh` / `api4.cursor.sh`）的请求被本地安全代理（`http://127.0.0.1:45678`）拦截；
2. **协议转码**：独立引擎将 Cursor 私有的 Protobuf / Connect-RPC 请求逆向解析，提取上下文并基于前缀树计算缓存指纹，转换为标准 OpenAI 协议转发至本地 Magpie 网关；
3. **Tab 分流与加速**：Tab 代码补全请求根据配置分别定向：官方 Token 极速模式走官方 Checksum 分流，Magpie 模型补全模式调度至指定的代码模型；
4. **双向流式回传**：上游模型的流式 Token、思考过程（Thinking Tokens）与工具调用（Tool Calls）实时编码回 Connect-RPC 二进制流秒级回传 Cursor。

---

### 🚀 快速开始

#### 方式一：在 Magpie 中直接加载（推荐）

1. 打开 **Magpie** 设置 -> **插件管理**；
2. 点击 **“添加本地插件”**，选择本仓库所在文件夹；
3. 在 Magpie 的 **Agents** 列表中开启 **Cursor · Magpie 智能桥接** 并选择模型；
4. 在 Magpie 左侧菜单点击 **Cursor 桥接控制台**，即可根据需要配置 Tab 补全或参数；
5. Cursor 即刻畅享 Magpie 模型与智能补全！

#### 方式二：命令行一键安装守护进程

在终端（PowerShell 或 Bash）中执行：

```bash
# 进入插件目录
cd magpie-agent-cursor-bridge

# 运行安装脚本
node install.js setup
```

安装程序会自动执行：
- 校验二进制完整性（SHA-256）；
- 初始化并信任本地自签 CA 根证书；
- 配置 Windows 启动守护项 / macOS LaunchAgent。

---

### 💡 常见问题与技巧

#### 1. 修改模型或切换 Tab 模式需要重启 Cursor 吗？
- **完全不需要！** 代理端口始终固定在 `http://127.0.0.1:45678`，所有模型切换和 Tab 设置均在本地代理内核内部实时生效，Cursor 客户端无感透明。
- **极速热重载**：若在初次配置或更换极端网络环境下需重新加载网络栈，无需完全退出 Cursor，直接在 Cursor 中按下快捷键 **`Ctrl + Shift + P`**（或 `F1`），输入并运行 **`Developer: Reload Window`（重载窗口）**，仅需 **1 秒钟** 即可热重载所有网络连接。

#### 2. Cursor Tab 代码智能补全如何选择？
- **官方 Token 极速模式（推荐）**：如果您有 Cursor 账号，在控制台点击 **“一键提取”** 获取本机 Token，即可使用官方 Checksum 毫秒级极速补全；
- **Magpie 模型补全模式**：在控制台将模式切换为“Magpie 模型补全模式”，下拉选择一个支持代码补全的模型（如 DeepSeek 等），点击 **“保存 Tab 设置”** 即可生效。

#### 3. 数据如何迁移到其他盘符（如 E 盘）？
- 打开控制台的 **“数据存储与迁移”** 卡片；
- 输入您的目标目录（例如 `E:\cursorbyokdb`），点击 **“迁移 / 切换”**；
- 若目标目录为空，系统会自动将当前数据库完整拷贝过去并绑定；若目标目录已有数据，将直接安全挂载生效。

---

<a name="english"></a>
## 🇬🇧 English

> Connect **Cursor** directly to any model configured in **Magpie** (GPT-6.1-Sol, Claude 3.7, Gemini 2.5, DeepSeek, etc.) with universal cross-platform paths, high prefix-cache hit rates, intelligent dual-mode Tab autocompletion, native Subagent scheduling, green portable storage, and seamless zero-restart hot-reloads.

### 🌟 Key Features

- ⚡ **Standalone High-Performance Rust Engine**: Built with native Rust MITM proxy, Connect-RPC / Protobuf transcoders, and embedded SQLite without cumbersome runtime dependencies.
- 🚫 **Hide Default Auto Picker**: Protocol-level suppression of Cursor's client-side Auto toggle using `ModelPickerDisplayConfiguration` (`hide_routed_model_view = true` and `NoAutoButton {}`). Graceful fallback guarantees deterministic local routing.
- 🏷️ **Intelligent Short Model Names**: Automatically extracts concise prefixes for models, preventing UI clipping in the Cursor model selector dropdown.
- 🧪 **Model Management & Real-time Latency Ping**: Embedded console card to view, live-filter, and test upstream model connectivity with ultra-lightweight 8-token pings.
- 🩺 **Integrated Log Viewer & System Diagnostics**: Direct web console view of `engine.log`, `supervisor.log`, and `supervisor-error.log` (last 80 lines) plus a one-click 5-point health check.
- ⌨️ **Cursor Tab Dual-Mode Autocompletion**:
  - **Official Token Mode (Recommended)**: Upstream routing across 16 specialized endpoints with dynamic checksum acceleration. One-click token extraction directly from local credentials.
  - **Magpie Model Mode**: Routes Tab completions to designated coding LLMs.
- 🤖 **Subagent (Task) Native Scheduling**: Full compatibility with Cursor Agent `Task` workflows; supports parent model inheritance and async background / sync blocking execution modes.
- 🎯 **High KV Prefix Cache Hit Rate**: Checkpoint fingerprint tree maintains **49%+ cache hit rate**, significantly slashing token consumption and Time-To-First-Token (TTFB).
- 💾 **Portable Storage & Live Migration**: Freely store `bridge.db` on any drive or external volume (e.g., Drive `E:\`). Automatic data synchronization and binding.
- 🔄 **Zero Cursor Restarts Required**: Fixed proxy port `http://127.0.0.1:45678` allows instant runtime model and setting swaps without interrupting your workflow.

---

### 🚀 Quick Start (English)

#### Method 1: Load directly in Magpie (Recommended)

1. Open **Magpie Settings** -> **Plugin Management**;
2. Click **"Add Local Plugin"** and select this directory;
3. Enable **Cursor · Magpie Bridge** in the Magpie **Agents** tab and select your preferred model;
4. Open the **Cursor Bridge Console** in the sidebar to configure Tab or database options;
5. Enjoy your favorite models in Cursor immediately!

#### Method 2: Command Line Setup

```bash
cd magpie-agent-cursor-bridge
node install.js setup
```

The installer verifies SHA-256 binary integrity, provisions the local MITM CA certificate, and configures the background service.

---

## 📦 Directory Structure

```text
magpie-agent-cursor-bridge/
├── bin/
│   └── win32-x64/
│       └── cursor-magpie-bridge.exe     # Standalone headless Rust proxy engine
├── control/                             # Web Console UI & API Server
│   ├── database.js                      # Direct SQLite inspection & maintenance
│   ├── server.js                        # Control HTTP service (port 3580)
│   ├── ui.html                          # Console web interface
│   ├── ui.js                            # Interactive frontend logic
│   └── ui.css                           # Console styling
├── lib/                                 # Platform, config, and installation logic
│   ├── bridge-settings.js               # Settings validator (bridge-settings.json)
│   ├── config.js                        # Magpie connection & model parser
│   ├── install.js                       # CA initialization & service management
│   ├── platform.js                      # Cross-platform path abstraction
│   └── settings.js                      # Cursor configuration patcher
├── scripts/
│   └── update-integrity.js              # Checksum calculation & integrity updater
├── agent.js                             # Magpie Agent descriptor
├── bridge.js                            # Background supervisor daemon
├── install.js / setup.command           # One-click installation scripts
├── integrity.json                       # Binary SHA-256 integrity manifest
└── package.json                         # Plugin manifest & metadata
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
