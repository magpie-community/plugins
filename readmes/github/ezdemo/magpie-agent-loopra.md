# Loopra Agent for Magpie

<img src="assets/loopra-logo.svg" alt="Loopra" width="80" height="80">

让 [Loopra](https://github.com/ezdemo/loopra) 出现在 Magpie 的 **Agent** 页面，使用 Magpie 管理的供应商、模型和路由组。适配 Loopra 的多渠道模型配置，同时兼容旧版单渠道字段。

这是按 [Magpie Agent 插件规范](https://usemagpie.ai/docs/zh/plugins#agents) 编写的 Agent 插件，不需要构建、安装依赖或启动额外服务。

## 安装与使用

需要已安装的 Loopra，以及支持 Agent 插件的 Magpie。已用 Magpie **0.1.1293** 完成真实插件加载、模型切换和断开恢复测试，配置字段按 Loopra **26.9.91** 源码适配。

```sh
magpie plugin add github:ezdemo/magpie-agent-loopra
```

也可以在 Magpie「插件 → 添加插件」中填写 `github:ezdemo/magpie-agent-loopra`。

1. 在 Magpie 里配置或登录你要使用的供应商。
2. 打开 **Agent → Loopra**，选择一个 Magpie 模型。
3. 重启 Loopra 后端服务；桌面端请退出后重新启动。新建会话，或在现有会话中选择 **Magpie** 渠道及其模型。

命令行也可以选择模型：

```sh
magpie models loopra
magpie loopra <供应商>/<模型>
```

模型 ID 原样保留为 `供应商/模型`，路由组为 `group/<组 ID>`。插件同时同步 Magpie 的模型展示名称，在支持 `displayName` 的 Loopra 版本中优先显示友好名称，长模型 ID 仍用于实际请求。在 Loopra 的模型选择器中也能切换 Magpie 提供的模型。

断开连接：

```sh
magpie loopra default
```

也可关闭 Agent 页的连接开关。断开后重启 Loopra 服务以加载恢复的配置。

## 模型配置适配

配置文件：`~/.loopra/config.json`，Windows 对应 `%USERPROFILE%\.loopra\config.json`。Web、CLI 和 Electron Desktop 的核心服务共用此配置目录；使用自定义 Java `user.home` 时需相应调整插件的 `agent.config` 和 `agent.dir`。

| Magpie 输入 | Loopra 配置 |
| --- | --- |
| 选中的 `model.id` | 顶层 `model`，由 Magpie 写入 |
| `gateway.v1` | Magpie 渠道的 `baseUrl` |
| `gateway.key` | Magpie 渠道的 `apiKey`，按 Loopra 独立统计用量 |
| 固定渠道 ID `magpie` | `modelChannelId`、渠道的 `id` |
| `models[].id` | `modelChannels[].models[].name` |
| `models[].name` | `modelChannels[].models[].displayName`，去除首尾空白；为空或缺失时不写入，界面回退到模型 ID |
| `models[].context` | `contextTokens`，未知时为 `-1` |
| `models[].output` | `maxTokens`，未知时沿用 Loopra 默认值 `32768` |
| `models[].images` | `imageInput`，仅明确支持时启用 |

渠道使用 `chat_completions`；上游供应商使用 Responses、Anthropic 等协议时，由 Magpie 网关转换。`specialCompatibility` 设为空，避免把原渠道的 OpenCode 等特殊兼容模式带到网关。插件还同步顶层 `baseUrl`、`apiKey`、`apiProtocol`、`specialCompatibility`、`availableModels`，供旧版 Loopra 使用。

Magpie 模型列表刷新时会重新调用 `connect`，同步列表、展示名称与能力。普通模型和路由组均使用相同的名称映射；展示名称不改变默认模型、辅助模型或请求中的模型 ID。旧版 Loopra 继续使用原始 ID。插件不修改工具审批模式、项目目录或会话数据，也不推测模型价格。

## 资源库：Skills、MCP、统一指令

在 Magpie 的资源库中，将相应指令、技能、MCP 服务的目标勾选为 **Loopra**。仅安装插件不会自动把全部资源分配给 Loopra。

| 资源 | 同步位置 | Loopra 如何读取 |
| --- | --- | --- |
| Skills | `~/.loopra/skills` | 使用现有全局技能目录；可刷新技能或重启服务 |
| 统一指令 | `~/.loopra/loopra.md` | 现有用户级提示词入口，保留原指令，Magpie 只管理自己的标记区块 |
| MCP | `~/.loopra/mcp-servers.json` 的 `mcpServers` 对象 | 需要下述 Loopra MCP 兼容改动；更新配置后重启服务 |

**MCP 的必要前提：** Loopra 后端须包含 [Magpie 兼容改动](https://github.com/ezdemo/loopra/pull/12)。旧版管理服务只读取 `servers` 数组，无法完整处理 Magpie 写入的 `mcpServers`。兼容版合并读取两种格式，同名时 `mcpServers` 优先，保存时保留各自区段、用户扩展字段及被覆盖的原生配置；移除 Magpie 项目后原生配置重新生效。支持 stdio、SSE、HTTP/Streamable HTTP。

资源分配与模型连接开关彼此独立：`magpie loopra default` 恢复模型配置；要停止下发资源，请在资源库取消 Loopra 的勾选，再同步。Magpie 负责撤回自己写入的内容，不删除你原有的指令、技能或本地 MCP。

```sh
magpie library sync
```

## 思考强度与辅助模型

0.2.0 默认启用自动映射：

- **思考强度：** 只从所选模型的 `efforts` 中选择，依次偏好 `high`、`medium`、`low`、`minimal`、`none`、`xhigh`、`max`。未公布可识别档位时不接管此字段，保留或恢复原设置。
- **图片理解：** 优先使用支持图片的主模型；否则从可用模型中选择第一个明确支持图片输入的模型；都不支持时清空回退模型，避免引用失效的旧渠道。
- **危险操作校验：** 默认使用主模型发起独立校验请求，渠道指向 Magpie。此功能会增加模型请求；不改变 Loopra 的原有工具权限与人工审批规则。
- **工具模型：** 默认使用主模型生成会话标题，`toolModel` 和 `toolModelChannelId` 同步指向 Magpie；切换主模型时同步更新。设为 `none` 时清空这两个字段，Loopra 使用消息截取标题。
- **恢复：** 被接管的 `reasoningEffort`、图片理解、校验及工具模型/渠道字段均由 Magpie 备份，断开模型连接后恢复；原配置没有的字段会移除。

Magpie 尚不提供自定义 Agent 控件，所以这里不会新增思考强度或辅助模型下拉框。需要固定默认值时，从本地目录安装插件并编辑 `loopra-policy.js`：

```js
export const policy = {
  reasoningEffort: "auto",                   // auto 或模型支持的档位，如 medium
  imageUnderstandingModel: "vendor/vision", // auto、完整模型 ID 或 none
  validationModel: "vendor/reviewer",       // auto、完整模型 ID 或 none
  toolModel: "auto",                       // auto、完整模型 ID（含 group/ 路由组）或 none
};
```

指定的辅助模型必须存在于当前 Magpie 模型列表，图片模型还必须声明支持图片。无效配置会在写入前报错。修改本地策略后重新选择模型或重新连接；直接修改 GitHub 安装包内的文件可能被后续更新覆盖。

Loopra 会话中仍可调整模型、思考强度和辅助模型配置，但 Magpie 再次同步接管字段时会应用上述策略。

## 原配置与已有会话

- **连接期间，`modelChannels` 临时替换为一个 Magpie 渠道。** Magpie 的 Agent 插件接口不提供原文件内容，无法合并原有渠道。原渠道由 Magpie 备份，断开后按原类型完整恢复；其他无关配置保留。
- 连接期间请在 Magpie 管理模型。手动修改被接管的字段（包括添加 Loopra 渠道）可能在同步或恢复时被替换。需要编辑原渠道时，先断开连接。
- 已有会话保存了自己的模型和渠道选择，修改全局默认值不会自动改写这些会话。请新建会话，或在会话里重新选择 Magpie 渠道与模型。
- 连接时会把图片理解、校验模型映射到 Magpie 渠道，断开后恢复原渠道；已有会话仍需重新选择或新建。

## 本地开发与验证

插件运行于 Magpie 内置的 moejs，不使用 Node、文件系统、网络或第三方模块。只有测试需要 Node.js 22+。

```sh
git clone https://github.com/ezdemo/magpie-agent-loopra.git
cd magpie-agent-loopra
npm test
npm run test:integration
```

集成测试需要 PATH 中的 Magpie CLI；也可设置 `MAGPIE_BIN` 为其可执行文件的绝对路径。测试使用临时 HOME、USERPROFILE、应用数据目录和 XDG 目录，不改动实际 Loopra / Magpie 配置，不使用真实模型或登录信息。覆盖真实 moejs 加载、模型切换、辅助模型字段恢复，以及资源库中技能、统一指令、MCP 的实际同步与撤回。

开发时可手动安装本地目录：

```sh
magpie plugin add .
```

更新：

```sh
magpie plugin update
```

许可证：[MIT](LICENSE)。
