# magpie-agent-delta

> Use any AI model in [Delta](https://delta.dev) (by Zed Industries) through [magpie](https://usemagpie.ai).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![magpie-plugin](https://img.shields.io/badge/topic-magpie--plugin-orange.svg)](https://github.com/topics/magpie-plugin)

## Features

- **Any Model Routing**: Switch Delta to Claude, GPT, DeepSeek, Gemini, MiniMax, or any custom routing group in one click via Magpie.
- **Reasoning Effort Passthrough**: Automatically maps model reasoning / thinking effort (`low`, `medium`, `high`, `xhigh`, `max`) into Delta's `reasoning_efforts`.
- **Accurate Context Windows**: Dynamically passes the model's actual context window (`context_window`) and output token limit (`max_output_tokens`).
- **Safe Stash & Clean Restoration**: Configures Magpie as the active custom provider under `native.custom_providers`. Magpie's built-in stash mechanism (`stash.json`) automatically backs up pre-existing custom providers and restores them completely when disconnected (`magpie delta default`).
- **Library Ecosystem Synchronization**: Bridges Magpie's Library skills and MCP tools directly into `~/.agents/skills`, `~/.agents/mcp.json`, and `~/.agents/AGENTS.md`.

---

## Installation & Usage

### Method 1: Via CLI (Local Development)
```bash
# Add from local packages folder
magpie plugin add ./packages/delta

# Connect Delta to a model
magpie delta codearts/glm-5.3-flash

# Disconnect and restore original configuration
magpie delta default
```

### Method 2: Via npm (Once Published)
```bash
magpie plugin add @magpie-community/agent-delta
```

---

## How It Works

This agent integration is built against Magpie's Agent Plugin Specification and targets Delta's native engine:
1. **Config Discovery**: Discovers Delta's configuration path (`%APPDATA%\delta\settings.json` on Windows, `~/.config/delta/settings.json` on macOS/Linux).
2. **Native Custom Provider Configuration**: Configures the `Magpie` OpenAI-compatible gateway into `native.custom_providers` adhering to Delta's `StoredSettings` schema.
3. **Worker Profile Binding**: Sets the active worker model (`portable.profiles.worker.model`). Subagent profiles inherit this model by default.
4. **Library Bridging**: Maps Library assets to Delta's native paths (`~/.agents/skills`, `~/.agents/mcp.json`, and `~/.agents/AGENTS.md`).
5. **Clean Unwire**: Magpie automatically restores the original custom providers and profiles on disconnect, leaving no orphaned objects.

---

## 中文说明

### 🌟 特性

- 🔄 **全模型支持**: 在 Magpie 中一键将 Delta 切换至任意大模型或自定义路由组。
- 🧠 **思考等级透传**: 自动将模型推理思考深度同步至 Delta 的 `reasoning_efforts`。
- 📏 **精准上下文窗口**: 动态传递各模型的实际上下文窗口长度与最大输出 Token。
- 🛡️ **安全暂存与平滑还原**: 在 `native.custom_providers` 中配置 Magpie 网关。Magpie 自动暂存用户原有的 Custom Provider，断开连接时（`magpie delta default`）原样恢复，不残留多余键值。
- 📚 **Library 生态互通**: 自动对齐 Magpie 的 Library（Skills、MCP）到 Delta 原生识别的 `~/.agents/skills` 与 `~/.agents/mcp.json`。

### ⚙️ 使用说明

```bash
# 本地加载插件
magpie plugin add ./packages/delta

# 切换 Delta 绑定的模型
magpie delta <provider/model>

# 断开连接并还原原有配置
magpie delta default
```

---

## License

[MIT](LICENSE) © [KuaaMU](https://github.com/KuaaMU)
