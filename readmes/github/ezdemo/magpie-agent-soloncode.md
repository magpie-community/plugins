# SolonCode Agent for Magpie

<img src="https://solon.noear.org/img/solon/favicon256.png" alt="SolonCode" width="80" height="80">

让 [SolonCode](https://github.com/ezdemo/soloncode) 出现在 Magpie 的 **Agent** 页面，使用 Magpie 管理的供应商、模型和路由组。插件把 Magpie 网关适配为 SolonCode 的一个 OpenAI 兼容供应商，并同步完整模型目录、上下文长度和推理强度默认值。

这是按 [Magpie Agent 插件规范](https://usemagpie.ai/docs/zh/plugins#agents) 编写的 Agent 插件，不需要构建、安装依赖或启动额外服务。配置字段按 SolonCode **v2026.11.26** 源码适配。

## 安装与使用

需要已安装的 SolonCode，以及支持 Agent 插件的 Magpie。

```sh
magpie plugin add github:ezdemo/magpie-agent-soloncode
```

也可以在 Magpie「插件 → 添加插件」中填写 `github:ezdemo/magpie-agent-soloncode`。

1. 在 Magpie 里配置或登录你要使用的供应商。
2. 打开 **Agent → SolonCode**，选择一个 Magpie 模型。
3. 重启 SolonCode 后端服务；桌面端请退出后重新启动。新建会话，或在会话中重新选择 Magpie 模型。

命令行也可以选择模型：

```sh
magpie models soloncode
magpie soloncode <供应商>/<模型>
```

模型 ID 原样保留为 `供应商/模型`，路由组为 `group/<组 ID>`。SolonCode 的 `defaultModel` 必须能匹配实际模型名，因此插件同时使用完整模型 ID 作为 SolonCode 的 `name` 与 `model`；Magpie 的展示名称写入模型 `description` 和供应商目录的 `displayName`，不改变请求中的模型身份。

断开连接：

```sh
magpie soloncode default
```

也可关闭 Agent 页的连接开关。断开后重启 SolonCode 服务以加载恢复的配置。

## 模型配置适配

配置文件：`~/.soloncode/settings.json`，Windows 对应 `%USERPROFILE%\.soloncode\settings.json`。CLI、Web 和 Desktop 共用该全局配置；工作区 `.soloncode/settings.json` 仍可按 SolonCode 规则覆盖本地配置。

| Magpie 输入 | SolonCode 配置 |
| --- | --- |
| 选中的 `model.id` | 顶层 `defaultModel`，由 Magpie 写入 |
| `gateway.v1` | `providers.magpie.apiUrl` 与各模型的 `apiUrl` |
| `gateway.key` | `providers.magpie.apiKey` 与各模型的 `apiKey` |
| 固定供应商 ID `magpie` | `providers.magpie`、各模型的 `provider` |
| `models[].id` | `models` 的键、`name`、`model`，以及供应商目录的 `id` |
| `models[].name` | 模型的 `description`、供应商目录的 `displayName`；为空时不写入 |
| `models[].context` | 模型的 `contextLength`、供应商目录的 `maxInputTokens`；未知或非法时不写入 |
| `models[].output` | 供应商目录的 `maxTokens` |
| `models[].efforts` | 所选模型的 `defaultOptions.reasoning_effort` |

供应商使用 `standard: "openai"`。`gateway.v1` 是 OpenAI 兼容基础地址，SolonCode 的 OpenAI 方言会补全 `/chat/completions`；上游供应商使用 Responses、Anthropic 等协议时，由 Magpie 网关转换。

`output` 只同步到供应商目录的 `maxTokens` 元数据。SolonCode 没有单独的“最大输出能力”模型字段，插件不会把它写成每个请求都强制携带的 `max_tokens`，避免不必要地提高成本或触发上游限制。

Magpie 模型列表刷新时会重新调用 `connect`，同步供应商目录和模型条目。连接期间 `providers` 与 `models` 临时替换为 Magpie 管理的对象；原配置由 Magpie 备份，断开后恢复。插件不修改工具审批模式、工作区、会话数据或价格信息。

## 资源库：Skills、MCP、统一指令

在 Magpie 的资源库中，将相应指令、技能、MCP 服务的目标勾选为 **SolonCode**。仅安装插件不会自动把全部资源分配给 SolonCode。

| 资源 | 同步位置 | SolonCode 如何读取 |
| --- | --- | --- |
| Skills | `~/.soloncode/skills` | 现有用户级技能目录；可刷新技能或重启服务 |
| 统一指令 | `~/.soloncode/AGENTS.md` | 现有用户级 `AGENTS.md` 入口，保留原指令，Magpie 只管理自己的标记区块 |
| MCP | `~/.soloncode/settings.json` 的 `mcpServers` 对象 | SolonCode 原生配置位置；更新后重启服务 |

MCP 与模型配置共用同一个 `settings.json`。Magpie 写入 `mcpServers` 时应保留文件中的模型、供应商和其他设置；集成测试覆盖了这一行为。资源分配与模型连接开关彼此独立：`magpie soloncode default` 恢复模型配置；要停止下发资源，请在资源库取消 SolonCode 的勾选，再同步。

插件按 `devin` 兼容格式写入 MCP 条目（`transport` 加 `command` / `args` / `env` 或 `url` / `headers`），这些字段会被 SolonCode 正常识别。SolonCode 当前不会在 MCP 配置中展开 `${NAME}` 环境变量引用；因此包含这类引用的服务不会被 Magpie 下发给 SolonCode，避免把占位符原样当作凭据发送。此类服务请改用实际值，或等 SolonCode 支持变量展开后再调整格式。

```sh
magpie library sync
```

## 推理强度

SolonCode 支持 `low`、`medium`、`high`、`max`。插件只把所选模型公布且 SolonCode 支持的档位写入该模型的 `defaultOptions.reasoning_effort`，自动模式依次偏好 `high`、`medium`、`low`、`max`。

- 未公布 `efforts`、公布为空，或只有 `minimal` / `none` / `xhigh` 等 SolonCode 不支持的档位时，不写入该选项，SolonCode 保持 auto 行为。
- 推理默认值只写在当前选中的模型上；在 SolonCode 中切换到其他 Magpie 模型后，可在会话模型选择器中手动选择强度。
- 会话中显式选择的推理强度优先于 `defaultOptions`；选择 auto 时才回到这里写入的模型默认值。

Magpie 尚不提供自定义 Agent 控件。需要固定默认值时，从本地目录安装插件并编辑 `soloncode-policy.js`：

```js
export const policy = {
  reasoningEffort: "auto", // auto、low、medium、high 或 max
};
```

固定档位必须同时被所选模型的 `efforts` 公布（未公布目录时视为允许）；无效配置会在写入前报错。修改本地策略后重新选择模型或重新连接；直接修改 GitHub 安装包内的文件可能被后续更新覆盖。

## 原配置与已有会话

- **连接期间，`providers` 和 `models` 临时替换为 Magpie 管理的内容。** Magpie 的 Agent 插件接口不提供原文件内容，无法合并原有供应商和模型。原对象由 Magpie 备份，断开后完整恢复；其他无关配置保留。
- 连接期间请在 Magpie 管理模型。手动修改被接管的字段可能在同步或恢复时被替换。需要编辑原供应商或模型时，先断开连接。
- 已有会话可能保存自己的模型状态，修改全局默认模型不会自动改写这些会话。请新建会话，或在会话里重新选择 Magpie 模型。
- 工作区级 `.soloncode/settings.json` 是 SolonCode 自身的覆盖层；插件只声明用户级配置文件。使用自定义 Java `user.home` 时需相应调整插件的 `agent.config` 和 `agent.dir`。

## 本地开发与验证

插件运行于 Magpie 内置的 moejs，不使用 Node、文件系统、网络或第三方模块。只有测试需要 Node.js 22+。

```sh
git clone https://github.com/ezdemo/magpie-agent-soloncode.git
cd magpie-agent-soloncode
npm test
npm run test:integration
```

单元测试覆盖插件元数据、完整模型 ID、展示名称、上下文长度、推理强度、目录刷新和输入校验。集成测试需要 PATH 中的 Magpie CLI；也可设置 `MAGPIE_BIN` 为其可执行文件的绝对路径。测试使用临时 HOME、USERPROFILE、应用数据目录和 XDG 目录，不改动实际 SolonCode / Magpie 配置，不使用真实模型或登录信息。覆盖真实 moejs 加载、模型切换、配置恢复，以及资源库中技能、统一指令、MCP 的实际同步与撤回。

开发时可手动安装本地目录：

```sh
magpie plugin add .
```

更新：

```sh
magpie plugin update
```

许可证：[MIT](LICENSE)。
