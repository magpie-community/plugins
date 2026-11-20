# Magpie Trae Evergreen

[English](README.en.md)

让 Trae CN 使用 Magpie 里配置的模型和路由组。接入后，在 Trae 自己的模型菜单里选择带「· Magpie」的条目。

> **这是什么**：一个 Windows 上的 Trae CN Agent 适配器，把 Magpie 的模型登记成 Trae 的自定义模型，并在本机起一个请求桥接服务。
>
> **和原版的区别**：原版靠「客户端版本号 + 文件 SHA-256 白名单」放行，Trae 每升级一次就可能失配；本版改为按**凭据信封布局校验 + 服务端密文自检**放行，不绑定具体构建号。

## 二次开发声明

本项目基于 [lmy414/magpie-agent-trae](https://github.com/lmy414/magpie-agent-trae)（作者 [@lmy414](https://github.com/lmy414)）二次开发，沿用其 Agent 接入契约、目录同步、恢复日志与请求桥接的整体设计。原始项目的架构梳理与实现质量打下了绝大部分基础，**感谢原作者的工作**。

上游采用 MIT 许可，本项目同样以 MIT 发布，原始版权声明予以保留。

| 项 | 原版 `magpie-agent-trae` | 本项目 `magpie-trae-evergreen` |
| --- | --- | --- |
| 客户端放行方式 | 版本号 + DLL/入口文件 SHA-256 白名单 | 布局校验 + 用账号目录已有的 `ak` 密文解密验真 |
| 新版本 Trae 发布后 | 需等插件更新白名单 | 通常无需改动；方案真变了才报错 |
| 安装路径 | 假定 `%LOCALAPPDATA%\Programs\Trae CN` | 注册表 → 常规路径 → 客户端启动日志，多盘可用 |
| 客户端补丁 | 按已知哈希匹配 `out/main.js` | 结构化校验 + 按版本隔离备份 + manifest 记录原始哈希 |
| 同步写入 | 连续写入 | 每条之间 300ms 节流 |
| 运行时命名空间 | `magpie-trae` / `trae-local` / 3498 | `magpie-trae-evergreen` / `trae-cn-evergreen` / 3499 |
| 与原版共存 | — | 配置、端口、Agent ID、规则文件互不重叠 |

**命名空间为什么要分开**：两套适配器若共用 `~/.config/magpie-trae/`，会互相覆盖 `connection.json`、`sync-status.json`，更危险的是覆盖 `managed-models.json`（恢复日志）与 `client-backups/`（回滚备份）——一个插件可能删掉另一个插件创建的模型，或用错的原文件还原客户端。因此本项目所有运行时状态都放在独立目录。

## 兼容性

支持 **Windows 上的 Trae CN**。国际版、macOS、Linux 尚未适配。

| 客户端 | 状态 |
| --- | --- |
| Trae CN 3.4.18 | 上游已核验，本版沿用同一信封布局 |
| Trae CN 3.4.20 | 上游已核验 |
| Trae CN 3.4.22 | 本版实测：目录同步、模型增删、菜单热更新、实际对话均正常 |
| 其它 3.4.x | 布局不变即可用；方案变更时会明确报 `trae_credential_key_unverified`，不会静默写入错误凭据 |

不再维护「已验证构建」清单。放行的判断依据是：两个 DLL 里提取的常量能否组成合法的 AES-256-GCM 信封，以及该信封能否解开 Trae 账号目录里**已经存在**的 `ak` 密文。后者是密码学意义上的强校验，且与版本号无关。

## 安装

先安装并登录 Trae CN，在 Magpie 中配置可用的模型，然后：

```powershell
magpie plugin add "github:CN-P5/magpie-trae-evergreen#new"
```

也可以下载源码后，进入目录执行 `magpie plugin add .`。

1. 在 Magpie 的 Agent 页面找到 **Trae CN · Evergreen**，打开接入开关。列表较长时展开底部「显示其余」区域。
2. 首次安装（或 Trae 升级后重装）客户端刷新组件后，自行重启 Trae 一次。
3. 在 Trae 的模型菜单选择带「· Magpie」的条目。

保持 Magpie 运行、Trae 保持登录。插件不会切换窗口焦点、修改输入框或自动选择模型。

### 从原版迁移

两套插件的模型都指向各自的本地端口，不能平滑接管，需要一次干净切换：

1. 在 Magpie 里**关闭原版 Trae 的接入开关**，等 `sync-status.json` 变为 `disconnected`——原版会删除它创建且你未手动修改的条目。
2. 确认 Trae 模型菜单里不再有旧条目（手动改过的会保留，可自行删除）。
3. 安装本插件并打开开关，新条目会在 3499 端口重新创建。

**如果之前装过改名前的版本**（`magpie-trae` / 3498）或换过 Magpie 里的模型选择，账号里可能留下「· Magpie」同名条目——它们指向一个已经没人监听的端口，选它们聊天会失败，而恢复日志里没有记录，断开也不会清理。先预演，再执行：

```powershell
node cli.mjs cleanup           # 只列出，不删除
node cli.mjs cleanup --apply   # 删除确认无人监听的、且当前未选中的条目
```

清理只动两类东西：后缀为「· Magpie」、指向本机回环端口、**不在恢复日志里、也不在当前选择中**的条目。监听中的其它适配器、以及当前选中的模型都不会被删。

不要在两个插件都启用的情况下反复切换，Trae 侧的 `mcp.json` 与规则文件是固定路径，无法隔离。

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

![Magpie 与 Trae 的聊天请求、模型目录和凭据使用路径](assets/architecture.zh-CN.svg)

### 模型怎样进入 Trae

`trae.agent.js` 实现 Magpie 的 Agent 接入契约。`connect()` 返回网关地址、网关密钥和所选模型的能力信息，由 Magpie 宿主写入 `connection.json`。Agent 的发现目录是 Trae 的数据目录，与连接配置分开，因此清空所选模型不会删除用于发现 Trae 的目录。

`sync.mjs` 将模型转换为 Trae 的 `custom_openai_compatible` 配置，映射模型 ID、名称、上下文长度、输出上限、图片能力和思考档位。显示名称追加「· Magpie」，请求地址指向本地桥接的 `/v1/chat/completions`。

Trae 把这些自定义模型保存在账户服务中。`trae-api.mjs` 读取本机已登录 Trae 的 JWT、设备信息和版本信息，调用模型查询、添加与更新接口。删除通过更新接口的 `action: "delete"` 完成。插件不直接写入 Trae 的 SQLite 模型缓存。

Trae 要求凭据使用原生编码格式。`trae-local-token.mjs` 从本机 DLL 提取内置加密材料，用 AES-256-GCM 编码本地桥接标记；提取结果必须能解开账号目录里已有的 `ak` 才会被采用。安装包不包含这些 DLL 或内置密钥，但运行时确实会读取它们。

**AK 和空 SK 都必须使用原生编码。** 模型管理接口接受明文空 SK，实际聊天校验却会拒绝。

### 聊天请求怎样转发

`bridge.mjs` 默认监听 `127.0.0.1:3499`。它只接受本机来源，拒绝带浏览器 `Origin` 的请求，并检查本地 Host、桥接标记和所选模型 ID。

桥接保留消息体中的工具定义、图片和思考参数，重新构造发往 Magpie 本机网关的请求。鉴权头改为 Magpie 网关密钥，Trae 的云端鉴权头不继续转发。响应通过原始流管道返回，避免破坏分段工具参数和用量信息。下游连接提前关闭时，桥接会销毁对应的上游 HTTP 请求。

「模型地址在本机」不表示 TraeWork 的会话编排也在本机：Trae 云端仍参与会话处理，最终模型服务由 Magpie 的供应商与路由配置决定。

### 模型变化、断开和客户端刷新

![模型同步、断开恢复与两种客户端修改的行为](assets/lifecycle.zh-CN.svg)

`startModelSync()` 每 5 秒检查连接配置；内容未变化时，每 60 秒重新核对原生目录。这些间隔不代表同步一定会在相同时间内完成，账户接口的响应和回读确认也需要时间。

模型移除和断开使用同一套撤回逻辑。恢复日志记录插件管理的模型 ID、接管前配置和最后写入的指纹。插件新建且未被用户修改的模型会删除；接管且未被用户修改的模型恢复原配置；用户后来改过的条目保留，并产生警告。账号变化时停止使用旧账号的恢复日志。

每次写操作先记录待完成状态，再调用接口并回读确认；响应丢失时，下次同步先查询原生目录判断操作是否已完成，避免重复创建或误删。多条模型连续创建时按 300ms 间隔节流，降低被账户接口限流的概率。

模型目录写入成功后，同步器生成不包含原始凭据的目录修订号。`trae-refresh-notifier.cjs` 在 Trae 主进程中每 1 秒检查该修订号，变化时向各个窗口发送 Trae 原生模型变更通知，由窗口重新加载目录。

### 客户端文件的修改范围

| 功能 | 执行方式 | 实际改动 | 恢复方式 |
| --- | --- | --- | --- |
| 模型菜单热更新 | 插件默认启动时尝试安装 | 校验并备份 `out/main.js`，追加加载语句，安装 `out/magpie-model-refresh.cjs` | 执行 `node cli.mjs restore-client` 后重启 Trae |
| 取消卡死兼容修复 | 源码中的可选脚本，手动执行 | 校验并备份指定 `solo-lite` 程序文件，修复旧订阅延迟状态和取消确认后的状态核对 | 同一脚本使用 `--restore` 后重启 Trae |

热更新的安装入口在 `index.mjs`，文件修改和恢复在 `client-refresh.mjs`。不想改动客户端文件时，设置环境变量 `MAGPIE_TRAE_NO_CLIENT_PATCH=1` 即可跳过——代价是新增模型后需重启 Trae 才能看到。

补丁只追加两行、不改动已有字节；原始文件按 Trae 版本备份到 `client-backups/<版本>/main.original.js`，并在 `manifest.json` 记录原始 SHA-256。若该文件内容与备份不一致（例如你手动改过或被其它工具改过），插件会拒绝覆盖并报 `trae_client_refresh_build_unsupported`。**断开接入会撤回模型配置，客户端入口补丁需要单独恢复。**

`scripts/trae-cancel-patch.mjs` 不包含在运行安装包中，也不会自动执行。它忽略已被替换订阅发来的延迟状态，并在取消已确认且没有活动流时重新核对后端终态。**仅适用于 3.4.18 构建。**

## 恢复与卸载

在 Magpie 关闭 Trae 接入，等待同步状态变为 `disconnected`，再卸载插件。插件只处理日志中记录的模型 ID：自己新增的条目会删除，接管过的条目会还原，手动修改过的条目会保留并报告 `model_edited_in_trae`。

客户端刷新组件独立于模型配置。卸载插件后，在源码目录执行：

```powershell
node cli.mjs restore-client
```

然后自行重启 Trae。**恢复前不要删除 `%USERPROFILE%\.config\magpie-trae-evergreen`**，该目录包含恢复日志和备份。

## 诊断

```powershell
node cli.mjs status
node cli.mjs models
```

| 文件 | 位置 |
| --- | --- |
| 连接信息 | `%USERPROFILE%\.config\magpie-trae-evergreen\connection.json` |
| 模型恢复日志 | 同目录的 `managed-models.json` |
| 同步状态 | 同目录的 `sync-status.json` |
| 凭据缓存 | 同目录的 `local-credential.json` |
| 客户端刷新记录 | 同目录的 `client-refresh-status.json` |
| 客户端入口备份 | 同目录的 `client-backups\<Trae 版本>` |

与原版（`magpie-trae`）的目录**完全独立**，两者互不读取、互不覆盖。

常见错误码：

| 错误 | 含义 |
| --- | --- |
| `trae_installation_unavailable` | 找不到 Trae 安装目录；可用 `TRAE_APP` 显式指定 |
| `trae_credential_profile_unknown` | 两个 DLL 里没有提取到合法的加密常量 |
| `trae_credential_key_unverified` | 提取到的密钥解不开账号目录里的 `ak`，说明客户端方案真的变了 |
| `trae_credential_invalid` | 凭据密文格式非法或校验失败 |
| `trae_sign_in_expired` | Trae 登录态过期，重新登录 |
| `trae_client_refresh_build_unsupported` | `out/main.js` 与备份不一致，未覆盖 |
| `trae_api_4024` | 同一 `(provider, model_name, base_url)` 已存在 |
| `duplicate_display_name`（警告） | 已有一个同名「· Magpie」条目指向别的本机端口。插件不会创建第二条，避免菜单里出现两个一样的名字；确认后运行 `node cli.mjs cleanup` |

**为什么会出现同名重复**：Trae 判重只看 `(provider, model_name, base_url)`，显示名不参与。所以换端口（例如从 3498 改到 3499）等于换了一个模型，服务端会照单新建一条同名条目。本版在写入前增加了同名检测，遇到就跳过并给出警告，不再继续制造副本。

连接信息和恢复日志可能包含凭据，请勿上传到 Issue。报告问题时提供版本、错误代码及已去除凭据的状态信息即可。

## 开发与验证

无需安装 npm 依赖。Node.js 20 或更高版本：

```powershell
npm test
npm pack
```

`npm run acceptance` 需要本机的 Magpie 与其 Bun 宿主，使用临时用户目录及本地测试服务，不调用真实模型账户。

当前验证情况：

- 60 项单元测试在 Node 22 与 Bun 1.4.4 下通过。
- Trae CN 3.4.22（安装在 `D:\Trae CN`）实测：安装目录定位、13 条目录读取、`ak` 密文解密、空 SK 编码、`out/main.js` 结构校验全部通过；随后完成 11 条模型同步与菜单热更新，实际使用正常。
- 上游 0.3.3 / 0.3.4 的验证记录（54 / 56 项测试、9 项隔离集成检查、3.4.18 与 3.4.20 实机）仍然有效，本版沿用其同步与撤回逻辑。

本次兼容修复不包含长会话的 `3003 / SSE finish` 问题。排查中观察到工具结果提交后的续接失败，以及 Trae 云端返回 500；尚未确认其根因。

## 许可与来源

项目代码使用 [MIT License](LICENSE)。图标归属见 [ASSET_NOTICE.md](ASSET_NOTICE.md)，复用的登录信息解码代码及许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。项目不附带 Trae 客户端文件。

- 上游项目：[lmy414/magpie-agent-trae](https://github.com/lmy414/magpie-agent-trae)（MIT），本项目的直接基础。
- 接口与实现参考：[Magpie Agent 文档](https://usemagpie.ai/docs/plugins#agents)、[Magpie 社区插件](https://github.com/magpie-community/plugins)。

本项目为非官方适配，与 Trae、字节跳动无关联，也未获得官方授权。
