# magpie-vetta (Official)

Vetta 官方维护的 Magpie 插件，为 [Vetta Desktop](https://github.com/openvetta/open-vetta) 提供 Magpie Agent 集成，随 Vetta 版本同步更新。在 Magpie 的 Agents 页打开 Vetta，Magpie 的模型就会出现在 Vetta 里，关掉即移除；同时通过 Library 向 Vetta 分发全局指令、MCP 服务器和 Skills。

## 功能

- 使用 Vetta 官方图标，并内嵌在插件中；显示图标不依赖网络。
- 将 Magpie Library 的全局指令写入 Vetta 的 `AGENTS.md`。
- 将 MCP 服务器和 Skills 分发到 Vetta 的默认 Agent 目录。
- 在 Agents 页开关 Vetta 时，把 Magpie 的模型（含路由组）写进 Vetta 的模型配置，关掉即原样还原。
- 为 Vetta 注册专属识别标记，供 Magpie 区分来自 Vetta 的请求。
- 沿用 Magpie 的资源分配、冲突处理和撤回机制。

Magpie 是 Vetta 使用 Magpie 模型的唯一入口：Vetta 设置里的 Magpie 一行只展示是否已接入，不再提供开关。

## 安装

在 Magpie 的插件发现页搜索 **magpie-vetta** 并安装，然后到 Agents 页打开 Vetta。源码本地安装可使用：

```sh
pnpm install --frozen-lockfile
pnpm build
magpie plugin add .
```

## 配置

在 Magpie 的 Library 页面选择 Vetta 作为资源接收方：

| Library 资源 | Vetta 路径                 |
| ------------ | -------------------------- |
| 全局指令     | `~/.vetta/agent/AGENTS.md` |
| MCP 服务器   | `~/.vetta/agent/mcp.json`  |
| Skills       | `~/.vetta/agent/skills/`   |

MCP 使用 `mcpServers` 配置格式。资源由 Magpie Library 管理；通过 Magpie 撤回分配后，插件不再向 Vetta 提供对应资源。

### 模型接入

在 Magpie 的 Agents 页打开 Vetta 后，插件会在 `~/.vetta/agent/models.json` 中写入整条 `providers.magpie`（标记为 `source: "magpie"`），包含本机网关地址、Vetta 专属密钥和 Magpie 提供的全部模型；Magpie 的模型列表变化时会自动更新。关掉 Vetta 时，Magpie 把这一条还原成打开前的样子。

请求按 Vetta 专属密钥归到 Vetta 名下，并附带 `User-Agent: Vetta`。在 Vetta 的模型选择器里选择 Magpie 的模型即可使用，无需重启 Vetta。

## 兼容性

需要 Vetta 0.6.27 及以上版本。Vetta 从这个版本起认得 Magpie 写入的模型配置，并把 Magpie 作为唯一入口：之前在 Vetta 设置里启用的 Magpie 会在升级后首次启动时移除，并弹窗提示改在 Magpie 中接入。更早的 Vetta 会把这条配置里的密钥挪走，Magpie 会因此认为连接已被改动。

插件使用 Vetta 默认目录 `~/.vetta/agent`。旧目录和自定义目录需要由用户自行迁移或管理。Magpie 插件加载和 Vetta Library 资源分发已在 Windows 上验证，Agents 页开关与模型接入已在 macOS 上验证；Linux 和其他 Vetta 启动配置尚未验证。

## 鸣谢

本插件基于 [wshiqyuan](https://github.com/wshiqyuan) 的 [magpie-agent-vetta](https://github.com/wshiqyuan/magpie-agent-vetta) 发展而来，并保留了其完整提交历史。Vetta 的 Agent 身份、Library 资源分发（全局指令、MCP、Skills）以及最初的 Magpie 接入都出自他的工作，感谢他为 Vetta 社区做的贡献。为了跟上 Vetta 的发版节奏，现由 Vetta 团队在这里维护，也欢迎他继续一起参与。

## 许可证

本项目采用 [MIT License](LICENSE)，版权归原作者 wshiqyuan 与 openvetta 共同所有。Vetta 图标取自 Vetta Desktop 仓库的 `apps/desktop/src/renderer/public/icon.png`，来源代码版本为 [`1793f66`](https://github.com/openvetta/open-vetta/tree/1793f66d177a5cb30b7b4e0e6593eacce69d513c)，遵循其 MIT 许可证。
