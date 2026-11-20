# Magpie Agent for Trae CN

[English](README.en.md)

让 Trae CN 使用 Magpie 中配置的模型和路由组。接入后，在 Trae 自己的模型菜单中切换带“· Magpie”的条目。

这是非官方 Agent 适配器。目前验证范围是 **Windows、Magpie 0.1.3078 和 Trae CN 3.4.18 的指定构建**。插件调用 Trae 客户端内部接口，并校验客户端文件哈希。其他版本、国际版、macOS 和 Linux 尚未适配。

## 安装

先安装并登录 Trae CN，在 Magpie 配置可用的模型，然后运行：

```powershell
magpie plugin add @magpie-community/agent-trae-desktop
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

## 工作方式与本机改动

Magpie 的官方 Agent 契约写入网关和目录控制文件，Bun 宿主负责同步原生模型并运行本地桥接。桥接只监听 `127.0.0.1:3498`，只转发到控制文件中的本机 Magpie 网关，不接受浏览器来源请求。

Trae 将自定义模型配置保存在账户服务中。插件读取本机 Trae 已有的登录态，调用客户端的模型管理接口。它不登录其他账户，也不修改 Trae 的 SQLite 缓存。凭据编码参数从哈希已验证的本机客户端读取，安装包不包含客户端 DLL、编码密钥或用户凭据。

TraeWork 的会话编排仍由 Trae 云端承担。云端经 Trae 的反向隧道请求本机桥接，再由 Magpie 调用上游。将模型地址指向本机，并不会将 TraeWork 的会话编排迁到本机。

为了更新已打开窗口的菜单，插件在 Trae 的 `out/main.js` 追加一条加载语句，并安装 `out/magpie-model-refresh.cjs`。安装前核对版本和 SHA-256，保存原文件。组件读取不含密钥的目录修订号，变化时发送 Trae 原生模型变更通知。它不开放调试端口。未知构建会拒绝改写并报告 `trae_client_refresh_build_unsupported`。

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
