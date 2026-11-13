# Magpie Agent for Trae CN

[English](README.en.md)

让 Trae CN 使用 Magpie 中配置的模型和路由组。接入后，在 Trae 自己的模型菜单中切换带“· Magpie”的条目。

这是非官方 Agent 适配器。目前验证范围是 **Windows、Magpie 0.1.3078 和 Trae CN 3.4.18 的指定构建**。插件调用 Trae 客户端内部接口，并校验客户端文件哈希。其他版本、国际版、macOS 和 Linux 尚未适配。

## 安装

先安装并登录 Trae CN，在 Magpie 配置可用的模型，然后运行：

```powershell
magpie plugin add "github:lmy414/magpie-agent-trae#v0.3.3"
```

也可以下载 [Release](https://github.com/lmy414/magpie-agent-trae/releases) 中的源码，进入解压后的目录，运行 `magpie plugin add .`。

1. 在 Magpie 的 Agent 页面找到 Trae，打开接入开关。列表较长时，展开底部“显示其余”区域。
2. 首次安装客户端刷新组件后，自行重启 Trae 一次。
3. 在 Trae 的模型菜单选择带“· Magpie”的条目。之后新增、移除模型和断开接入会自动刷新已打开的窗口。

保持 Magpie 运行、Trae 登录。插件不会切换窗口焦点、修改输入框或自动选择模型。只安装本仓库与社区包中的一个版本，避免两个运行时同时管理同一套配置。

## 能力

| 功能 | 行为 |
| --- | --- |
| 模型目录 | 同步 Magpie 提供的模型和路由组，在 Trae 内切换 |
| 模型能力 | 同步图片能力、上下文长度、输出长度和思考档位 |
| 请求转发 | 保留流式输出、图片、工具调用和思考参数 |
| 目录更新 | 每 5 秒检查控制文件，写入并核对后通知 Trae 刷新 |
| 移除与断开 | 删除插件创建且未手动修改的条目，恢复接管前已有条目的配置 |
| 资源库 | 通过 Magpie Library 选择并同步 MCP、技能和规则 |

图片、工具和思考能力取决于所选上游。上游的套餐到期、限流和余额不足仍会原样报错。

## 工作原理

插件把 Magpie 中选中的模型登记为 Trae 的自定义模型，并在本机启动一个请求桥接服务。TraeWork 仍使用 Trae 云端编排会话。模型调用经 Trae 原生反向隧道回到本机，再由桥接服务交给 Magpie。

以下图示对应 `v0.3.3`，源码基线为 [`7cea0df`](https://github.com/lmy414/magpie-agent-trae/tree/7cea0df1c9e7fde864479fe9ac81a89c98021bf9)。支持范围为 Windows 上已核验的 Trae CN 3.4.18 构建。

![Magpie 与 Trae 的聊天请求、模型目录和凭据使用路径](assets/architecture.zh-CN.svg)

### 模型怎样进入 Trae

[`trae.agent.js`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/trae.agent.js#L19) 实现 Magpie 的 Agent 接入契约。`connect()` 返回网关地址、网关密钥和所选模型的能力信息，由 Magpie 宿主写入 `connection.json`。Agent 的发现目录是 Trae 的数据目录，与连接配置分开，因此清空所选模型不会删除用于发现 Trae 的目录。

[`sync.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/sync.mjs#L45) 将模型转换为 Trae 的 `custom_openai_compatible` 配置。映射内容包括模型 ID、名称、上下文长度、输出上限、图片能力和思考档位。显示名称追加“· Magpie”，请求地址指向本地桥接的 `/v1/chat/completions`。

Trae 将这些自定义模型保存在账户服务中。[`trae-api.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/trae-api.mjs#L11) 读取本机已登录 Trae 的 JWT、设备信息和版本信息，调用模型查询、添加与更新接口。删除通过更新接口的 `action: "delete"` 完成。插件不直接写入 Trae 的 SQLite 模型缓存。

Trae 要求凭据使用原生编码格式。[`trae-local-token.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/trae-local-token.mjs#L36) 校验客户端版本和 DLL 哈希，从本机 DLL 提取内置加密材料，再用 AES-256-GCM 编码本地桥接标记。安装包不包含这些 DLL 或内置密钥，但运行时确实会读取它们。

此前 `invalid ak` 的关键修复在 [`TraeAPI.call()`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/trae-api.mjs#L39)：**AK 和空 SK 都必须使用原生编码。** 模型管理接口接受明文空 SK，实际聊天校验却会拒绝。当前代码在发送写入请求前统一编码空 SK。

### 聊天请求怎样转发

图中的前 3 步属于 Trae 自己的运行时，依据此前 TraeWork 请求排查和实际聊天验证。反向隧道由 Trae 提供，本插件没有另建公网隧道。插件代码从本地 HTTP 桥接开始接管请求。

[`bridge.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/bridge.mjs#L65) 默认监听 `127.0.0.1:3498`。它只接受本机来源，拒绝带浏览器 `Origin` 的请求，并检查本地 Host、桥接标记和所选模型 ID。

桥接保留消息体中的工具定义、图片和思考参数，重新构造发往 Magpie 本机网关的请求。鉴权头改为 Magpie 网关密钥，Trae 的云端鉴权头不继续转发。响应通过原始流管道返回，避免破坏分段工具参数和用量信息。下游连接提前关闭时，桥接会销毁对应的上游 HTTP 请求。

因此，“模型地址在本机”不表示 TraeWork 的会话编排也在本机。Trae 云端仍参与会话处理；最终模型服务由 Magpie 的供应商与路由配置决定。

### 模型变化、断开和客户端刷新

![模型同步、断开恢复与两种客户端修改的行为](assets/lifecycle.zh-CN.svg)

[`startModelSync()`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/sync.mjs#L227) 每 5 秒检查连接配置；内容未变化时，每 60 秒重新核对原生目录。这些间隔不代表同步一定会在相同时间内完成，账户接口的响应和回读确认也需要时间。

模型移除和断开使用同一套[撤回逻辑](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/sync.mjs#L201)。恢复日志记录插件管理的模型 ID、接管前配置和最后写入的指纹。插件新建且未被用户修改的模型会删除；接管且未被用户修改的模型恢复原配置；用户后来改过的条目保留，并产生警告。账号变化时停止使用旧账号的恢复日志。

每次写操作先记录待完成状态，再调用接口并回读确认。若响应丢失，下次同步先查询原生目录，判断操作是否已经完成，避免重复创建或误删。

模型目录写入成功后，同步器生成不包含原始凭据的目录修订号。[`trae-refresh-notifier.cjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/trae-refresh-notifier.cjs#L9) 在 Trae 主进程中每 1 秒检查该修订号，变化时向各个窗口发送 Trae 原生模型变更通知，由窗口重新加载目录。

### 客户端文件的修改范围

| 功能 | 执行方式 | 实际改动 | 恢复方式 |
| --- | --- | --- | --- |
| 模型菜单热更新 | 插件默认启动时尝试安装 | 校验并备份 `out/main.js`，追加加载语句，安装 `out/magpie-model-refresh.cjs` | 执行 `node cli.mjs restore-client` 后重启 Trae |
| 取消卡死兼容修复 | 源码中的可选脚本，手动执行 | 校验并备份指定 `solo-lite` 程序文件，修复旧订阅延迟状态和取消确认后的状态核对 | 同一脚本使用 `--restore` 后重启 Trae |

热更新的安装入口在 [`index.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/index.mjs#L9)，文件修改和恢复在 [`client-refresh.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/client-refresh.mjs#L16)。**断开接入会撤回模型配置，客户端入口补丁需要单独恢复。**

[`scripts/trae-cancel-patch.mjs`](https://github.com/lmy414/magpie-agent-trae/blob/7cea0df1c9e7fde864479fe9ac81a89c98021bf9/scripts/trae-cancel-patch.mjs#L14) 不包含在运行安装包中，也不会自动执行。它忽略已被替换订阅发来的延迟状态，并在取消已确认且没有活动流时，重新核对后端终态，避免一直等待不会再到来的结束事件。测试脚本中的 `new Function` 用于提取实际源码做回归验证，不在日常请求路径中。

此版本记录了 54 项单元测试、9 项隔离 Magpie 集成检查及一次实际 DeepSeek 聊天验证。取消补丁有 6 项源码回归检查，完整的手动取消验收仍待补充。这些结果不代表其他 Trae 构建或所有模型都已验证，也不代表 Trae 官方授权。

## 恢复与卸载

在 Magpie 关闭 Trae 接入，等待同步状态变为 `disconnected`，再卸载插件。插件只处理日志中记录的模型 ID：自己新增的条目会删除，接管过的条目会还原。手动修改过的条目会保留，并显示 `model_edited_in_trae`。

创建、更新和删除都有恢复日志。响应丢失时，插件读取原生目录核对结果；删除只有在确认条目不存在后才完成。账户发生变化时，插件停止使用原账户的恢复日志。

客户端刷新组件独立于模型配置。卸载插件后，在源码目录执行下列命令可恢复原入口文件，然后自行重启 Trae：

```powershell
node cli.mjs restore-client
```

不要在恢复前删除 `.config/magpie-trae`。该目录包含恢复日志和备份。

## 诊断

在源码目录运行：

```powershell
node cli.mjs status
node cli.mjs models
```

| 文件 | 位置 |
| --- | --- |
| 连接信息 | `%USERPROFILE%\.config\magpie-trae\connection.json` |
| 模型恢复日志 | 同目录的 `managed-models.json` |
| 同步状态 | 同目录的 `sync-status.json` |
| 客户端刷新记录 | 同目录的 `client-refresh-status.json` |
| 客户端入口备份 | 同目录的 `client-backups\3.4.18` |

连接信息和恢复日志可能包含凭据，请勿上传到 Issue。报告问题时提供版本、错误代码及已去除凭据的状态信息即可。

## 开发与验证

无需安装 npm 依赖。Node.js 20 或更高版本可运行单元测试：

```powershell
npm test
npm pack
```

`npm run acceptance` 需要本机的 Magpie 与其 Bun 宿主。脚本使用临时用户目录及本地测试服务，检查 Agent 注册、目录变化、转发和资料库恢复，不调用真实模型账户。

0.3.3 的验证包括 54 项单元测试、9 项隔离 Magpie 集成检查，以及已打开 TraeWork 窗口中的新增、替换和断开测试。目录核对完成后的菜单更新约需 1.1～1.6 秒。实际 DeepSeek 聊天已通过验证；该结果不代表所有上游模型都已验证。

## 可选的取消兼容修复

Trae CN 3.4.18 存在一种会话状态竞态：请求已经结束，旧的延迟状态仍把会话标记为运行中，随后取消会等待一个不会再到来的结束事件。

源码目录提供单独的、按构建哈希校验的修复脚本。它丢弃旧订阅的延迟状态，在无活动流的取消确认后核对后端终态。该脚本不随插件自动执行，也不包含在运行安装包中：

```powershell
node scripts/trae-cancel-patch.mjs --check
npm run test:cancel
node scripts/trae-cancel-patch.mjs --apply
# 需要撤回时：
node scripts/trae-cancel-patch.mjs --restore
```

执行修复或撤回后自行重启 Trae。脚本的原文件备份保存在源码目录的 `artifacts` 下。六项源码回归测试通过，完整的手动取消验收仍待补充。Trae 升级后应重新核验，不能直接套用旧补丁。

## 许可与来源

项目代码使用 [MIT License](LICENSE)。图标归属见 [ASSET_NOTICE.md](ASSET_NOTICE.md)，复用的登录信息解码代码及许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。项目不附带 Trae 客户端文件。

接口与实现参考：[Magpie Agent 文档](https://usemagpie.ai/docs/plugins#agents)、[Magpie 社区插件](https://github.com/magpie-community/plugins)及本机 Trae 的指定构建。
