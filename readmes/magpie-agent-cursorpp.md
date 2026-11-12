# Magpie → Cursor++

[English](README_EN.md) · MIT License · 无运行时依赖

把 [Magpie](https://usemagpie.ai) 的模型和路由组同步到 [Cursor++](https://github.com/CometixSpace/CCursor)，在 Cursor 中使用统一的 `provider/model` 模型目录。

## 功能

- Magpie 模型目录变化时自动同步，无需轮询或额外后台程序。
- 自动适配 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions。
- 同步模型名称、思考档位、上下文长度、输出上限和图片输入能力。
- 保留完整的 Magpie 模型 ID，包含路由组。
- 使用 Cursor++ 专用的本地网关凭据，不读取或复制供应商 API Key。

## 安装

要求：已安装 Magpie、Cursor 和 Cursor++，并开启 Cursor++ 的 BYOK Server。Cursor++ 默认监听 `127.0.0.1:39831`。插件支持 macOS、Windows 和 Linux，配置写入当前用户的 `~/.ccursor/providers.json`。

在 Magpie 的 **Plugins → Discover → Unofficial** 搜索本插件，或运行：

```sh
magpie plugin add github:teczt/magpie-cursorpp
```

发布到 npm 后，也可以运行：

```sh
magpie plugin add npm:magpie-agent-cursorpp
```

然后进入 **Agents → Cursor++**，将 Provider 设为 `magpie`。也可以使用命令行：

```sh
magpie cursorpp provider magpie
```

在 Cursor 模型菜单中选择以 `magpie/` 开头的模型即可。Cursor++ 通常会在 2 秒内重新读取配置；如果菜单没有立即刷新，请重新打开模型菜单。

## 配置管理方式

连接期间，本插件统一管理 `~/.ccursor/providers.json` 的 **`providers` 数组**（Windows 下位于当前用户目录，例如 `C:\Users\<用户名>\.ccursor\providers.json`），生成以下三个提供商：

| 提供商 ID | 接口 |
| --- | --- |
| `magpie` | Anthropic `/v1/messages` |
| `magpie-responses` | OpenAI `/v1/responses` |
| `magpie-chat` | OpenAI `/v1/chat/completions`，包含路由组 |

其他 Cursor++ 提供商在连接期间不会显示，不能与本插件同时手动编辑该数组。这是 Magpie Agent API 的数组写入方式决定的：它不能读取并按 ID 合并 `providers.json`。

**Magpie 会在首次连接前保存原配置，断开时自动恢复。** 插件不会写入供应商密钥，只写 Cursor++ 连接 Magpie 本地网关所需的凭据。

断开并恢复原配置：

```sh
magpie cursorpp default
```

也可以在 **Agents → Cursor++** 关闭 Magpie Provider。恢复后如需再次使用，重新设为 `magpie` 即可。

## 开发

需要 Node.js 20 或更高版本，不需要安装依赖：

```sh
npm run check
npm test
```

本地加载开发目录：

```sh
magpie plugin add ./
magpie cursorpp provider magpie
```

`agent.js` 只声明 Agent 并转发数据；`cursorpp.mjs` 负责纯数据转换，不含文件系统或网络操作。Magpie 负责配置写入、目录变化通知和断开恢复。

插件运行时由 Magpie 提供，用户不需要单独安装 Node.js；Node.js 20 仅用于本仓库的开发和测试。

## 许可证

[MIT](LICENSE)
