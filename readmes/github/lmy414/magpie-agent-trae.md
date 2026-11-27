# Magpie Agent for Trae CN

[English](README.en.md)

在 Trae CN 的模型菜单中使用 Magpie 配置的模型和路由组。自动同步的条目带有“· Magpie”后缀。本文适用于插件 0.4.1。

## 兼容性

自动同步适用于下表中已核验的 Trae CN 构建。同步器在写入模型前会校验两个原生库的 SHA-256。未通过校验的构建请手动接入。

| 平台与 Trae CN 版本 | 接入方式 | 验证范围 |
| --- | --- | --- |
| Windows 3.4.18 | 已核验安装支持自动同步 | 0.3.x 已验证目录同步和 DeepSeek 对话。 |
| Windows 3.4.20 | 已核验安装支持自动同步 | 0.3.x 已验证模型新增、修改、删除和回读。 |
| Windows 3.4.24 | 已核验安装支持自动同步 | 0.4.0 已验证凭据和登录会话。验证时用实际账户新增、查询和删除临时模型，测试条目已清理。 |
| Windows 3.4.25（构建 2.3.108162） | 已核验安装支持自动同步 | 已验证 4 个现有模型的后台同步和 Trae 账户目录回读。 |
| macOS 3.4.20 | 标准安装支持自动同步 | 审阅者验证了模型新增和移除，确认客户端文件未改动，应用代码签名仍有效。 |
| 其他版本或构建（包括 macOS 3.4.24 和 3.4.25） | 手动接入 | 自动同步未经验证。 |
| Linux | 桌面端适配未经验证 | CI 运行可移植代码的单元测试。 |

Windows 标准安装位于 `%LOCALAPPDATA%\Programs\Trae CN`。插件也能从注册表发现安装到其他目录的 Trae CN。对于移动过的安装，可以用 `TRAE_APP` 指向包含 `product.json` 的应用资源目录。感谢 CN-P5 分享 Windows 多盘安装的发现方法。[Magpie Trae Evergreen](https://github.com/CN-P5/magpie-trae-evergreen)

macOS 标准安装为 `/Applications/Trae CN.app` 或 `~/Applications/Trae CN.app`。其他位置的 macOS 安装请手动接入。

## 安装

先安装并登录 Trae CN，再在 Magpie 配置可用的模型。然后运行以下命令安装插件。

```sh
magpie plugin add "github:lmy414/magpie-agent-trae#v0.4.1"
```

也可以下载发布页面的 `magpie-agent-trae-0.4.1.tgz`，校验 SHA-256 后解压，在 `package` 目录运行 `magpie plugin add .`。[发布页](https://github.com/lmy414/magpie-agent-trae/releases)

在 Magpie 的 Agent 页面打开 Trae 接入开关。如果列表中看不到 Trae，展开底部的“显示其余”。插件在 Windows 和 macOS 上都使用 `dir: '~/.trae-cn'` 发现 Trae。`~/.trae-cn` 是 Trae 的跨平台产品数据目录。

### 自动同步

初次同步完成后，打开 Trae 的模型菜单，选择带“· Magpie”后缀的条目。安装后无需重启 Trae。

**已打开的模型菜单会保留原列表。** 在 Magpie 新增或移除模型后，等同步完成，再关闭并重新打开模型菜单。切换项目或重启 Trae 也会让 Trae 重新读取目录。Windows 和 macOS 的行为相同。

### 手动接入

运行 `magpie-trae setup` 查看本机桥接 URL 和本地令牌，再运行 `magpie-trae models` 查看可用的模型 ID。如果在源码目录操作，可以用 `node cli.mjs setup` 和 `node cli.mjs models`。

在 Trae 的“设置 → 模型”中添加 OpenAI Chat Completions 自定义模型，打开“完整 URL”，填入桥接 URL、本地令牌和模型 ID。此后增删或修改模型时，也在 Trae 的设置中管理这些条目。[Trae 模型设置](https://docs.trae.cn/work_models)

使用时保持 Magpie 运行、Trae 登录。更换安装位置或升级 Trae 后，重启 Magpie，让插件重新识别客户端。只安装本仓库或社区包中的一个版本，避免两个运行时管理同一套配置。

## 能力

模型目录和能力的同步，以及移除和断开时的清理，仅适用于支持自动同步的构建。手动接入的模型也能使用本地桥接。

| 功能 | 行为 |
| --- | --- |
| 模型目录 | 同步 Magpie 提供的模型和路由组，在 Trae 内切换 |
| 模型能力 | 同步图片能力、上下文长度、输出长度和思考档位 |
| 请求转发 | 保留流式输出、图片、工具调用和思考参数 |
| 目录更新 | 同步器写入 Trae 账户模型目录并回读。Trae 在重新打开模型菜单、切换项目或重启时读取目录 |
| 移除与断开 | 删除插件新建且未手动修改的条目，恢复接管前已有条目的配置 |
| 资源库 | 在 Magpie Library 中选择要同步的规则、技能和 MCP 服务器。macOS 上仅规则和技能可自动同步 |

图片、工具和思考能力取决于所选上游。上游的套餐到期、限流和余额不足仍会原样报错。

### macOS 资源库限制

macOS 上的 `$APPDATA` 为空。`$APPDATA/Trae CN/User/mcp.json` 因此展开为绝对路径 `/Trae CN/User/mcp.json`。Magpie 尝试创建 `/Trae CN` 时会遇到只读文件系统错误，所以无法自动写入 MCP 配置。规则和技能使用 `~/.trae-cn`，可以正常同步。

## 工作原理

下图展示插件的聊天请求、模型目录同步和凭据用途。Trae 在重新打开模型菜单、切换项目或重启时读取同步后的目录。

![Magpie 与 Trae 的聊天请求、模型目录同步和凭据用途](assets/architecture.zh-CN.svg)

### 模型怎样进入 Trae

`connect()` 返回 Magpie 网关地址、密钥和所选模型的能力信息。Magpie 宿主将这些信息写入 `~/.config/magpie-trae/connection.json`。Trae 的发现目录与连接配置分开，清空所选模型不会删除发现目录。[`trae.agent.js`](trae.agent.js)

同步器将选中的模型转换为 Trae 的自定义模型配置，写入 Trae 账户服务。模型地址指向本地桥接。插件使用本机已有的 Trae 登录会话调用模型管理接口，不直接写入 Trae 的 SQLite 模型缓存。[`sync.mjs`](sync.mjs)、[`trae-api.mjs`](trae-api.mjs)

Trae 要求按原生格式编码本地令牌和空 SK（Secret Key，秘密密钥）。插件以只读方式检查两个已安装的原生库（Windows 的 DLL 或 macOS 的动态库）的 SHA-256，再读取凭据编码所需的信息。安装包不包含这些库或内置密钥。[`trae-local-token.mjs`](trae-local-token.mjs)

### 聊天请求怎样转发

TraeWork 仍由 Trae 云端编排会话。模型请求通过 Trae 原生反向隧道到达本地桥接，再由 Magpie 按供应商和路由配置调用上游。

桥接默认监听 `127.0.0.1:3498`，只接受本机请求。它拒绝带浏览器 `Origin` 的请求，并检查本地 `Host`、本地令牌和所选模型 ID。转发时使用 Magpie 网关密钥，保留消息体和响应流。下游连接提前关闭时，桥接会关闭对应的上游请求。[`bridge.mjs`](bridge.mjs)

### 同步与撤回

下图展示插件怎样同步模型、Trae 何时读取目录，以及移除模型或断开时如何撤回变更。

![模型同步、Trae 读取目录的时机与断开恢复](assets/lifecycle.zh-CN.svg)

同步器每 5 秒检查连接配置。配置不变时，每 60 秒重新核对 Trae 账户中的模型目录。接口响应和回读确认也需要时间，检查间隔不等于同步耗时。[`sync.mjs`](sync.mjs)

每次写入前，插件先记录待完成操作，调用接口后再回读确认。若响应丢失，下次同步会先查询目录，再决定是否重试。移除模型或断开时，插件只处理日志记录的模型。用户在 Trae 中改过的条目会保留，并显示 `model_edited_in_trae`。账号变化后，插件会停止使用旧账号的日志。

## 恢复与卸载

- 手动接入时，在 Magpie 关闭 Trae 接入，再到 Trae 的“设置 → 模型”中移除不再使用的手动条目，然后卸载插件。
- 使用自动同步时，在 Magpie 关闭 Trae 接入，等待同步状态变为 `disconnected` 后再卸载插件。撤回完成前请保留 `managed-models.json`。

### 旧版客户端清理

插件仅在执行 0.3.x 遗留清理命令时修改 Trae 客户端文件。

旧版 Windows 安装可能在 `out/main.js` 末尾留下加载语句。对于 Windows 标准安装，在源码目录运行 `node cli.mjs restore-client`。命令只移除与旧版完全匹配的加载语句，并删除 `out/magpie-model-refresh.cjs`。在 macOS 上，该命令返回 `not_needed`。

## 会话与用量

Magpie 将桥接请求记到 `trae-local`。桥接将有效的会话 ID 写入 `X-Magpie-Session`，让同一会话的用量可跨模型归集。没有 ID 的请求单独计量。桥接不导入 Trae 本地历史。是否记录会话正文由 Magpie 的设置决定。

请求完成后，可用 `node cli.mjs status` 查看最近一次请求的 `lastRequest.sessionHeader`。字段显示识别到的请求头名称。`null` 表示这次请求没有可用的会话头。

## 诊断

运行 `magpie-trae status` 查看桥接与同步状态，运行 `magpie-trae models` 查看桥接提供的模型。在源码目录可改用 `node cli.mjs status` 和 `node cli.mjs models`。

| 文件 | 位置 |
| --- | --- |
| 连接信息 | `~/.config/magpie-trae/connection.json` |
| 模型恢复日志 | 同目录的 `managed-models.json` |
| 同步状态 | 同目录的 `sync-status.json` |

`~` 指当前用户的主目录。在 Windows 上对应 `%USERPROFILE%`。`node cli.mjs restore-client` 仅用于单独清理 0.3.x 的 Windows 遗留文件，不能用来恢复模型配置。

连接信息和恢复日志可能包含凭据，请勿上传到 Issue。报告问题时，提供插件和 Trae 的版本、错误代码以及已移除凭据的状态信息。

## 开发与验证

0.4.1 在 Windows 上通过了 66 项单元测试。运行测试需要 Node.js 20 或更高版本，无需安装 npm 依赖。用 `npm test` 运行测试，用 `npm pack` 检查安装包。

`npm run acceptance` 需要本机的 Magpie 与其 Bun 宿主。脚本使用临时用户目录和本地测试服务，检查 Agent 注册、目录变化、转发和资源库恢复。测试不调用真实模型账户。

长会话的 `3003 / SSE finish` 错误仍在排查。排查中观察到提交工具结果后续接失败，以及 Trae 云端返回 HTTP 500。根因仍未确认。

## 许可与来源

项目使用 MIT 许可证。安装包不附带 Trae 客户端文件。登录信息解码代码来自社区实现，图标的归属另有说明。[LICENSE](LICENSE)、[THIRD_PARTY.md](THIRD_PARTY.md)、[ASSET_NOTICE.md](ASSET_NOTICE.md)

项目使用 Magpie 的 Agent 接口，实现参考了社区插件。[Magpie Agent 文档](https://usemagpie.ai/docs/plugins#agents)、[Magpie 社区插件](https://github.com/magpie-community/plugins)
