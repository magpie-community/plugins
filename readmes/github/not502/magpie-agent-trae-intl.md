# magpie-agent-trae-intl

仓库地址：<https://github.com/not502/magpie-agent-trae-intl>

让 **Trae 国际版**使用 Magpie 中配置的模型。插件把 Magpie 选中的模型注册成 Trae 的自定义模型，在本机回环地址上启动一个请求桥，并持续把 Magpie 的模型目录同步到 Trae 的账户侧模型列表。

[English version](README.en.md)

- Magpie Agent 名称：**Trae (International)**（agent id `trae-intl`）
- Trae 模型菜单中的条目：`<模型显示名> · Magpie`
- 本机桥：`http://127.0.0.1:3499`
- 插件配置目录：`~/.config/magpie-trae-intl`
- 包版本：`0.1.0`，MIT

> **验证边界（先读）**
>
> 本仓库针对 **Windows 10/11 x64 + Trae 国际版 3.6.20 + Magpie 0.1.4596** 完成了静态契约核对、离线测试，以及**真实账号的模型目录验收**（2026-11-21：新增 → 回读 → 幂等复跑 → 释放删除全部通过，账户其余模型未受影响）。端到端聊天（在 Trae 里选中模型发消息）与真实安装目录上的可选热刷新补丁仍未验证。其他 Trae 构建、macOS、Linux 均未验证。
>
> 具体证据与缺口见 [`docs/design/architecture.md`](docs/design/architecture.md) 第 13 节和本文第 12 节。

---

## 1. 这个插件做什么

| 能力 | 行为 |
| --- | --- |
| 模型目录 | 把 Magpie 中选择的模型注册为 Trae 的 `custom_openai_compatible` 自定义模型，显示名追加 ` · Magpie` |
| 模型能力 | 同步上下文长度、输出上限、图片能力和思考档位 |
| 聊天转发 | Trae 的原生客户端把请求发到 `127.0.0.1:3499/v1/chat/completions`，桥替换鉴权头后转发给本机 Magpie 网关 |
| 请求保真 | 流式输出、工具调用、图片、`reasoning_effort` 原样保留；响应按原始字节回传 |
| 目录更新 | 每 5 秒检查连接文件，变化时同步；空闲时每 60 秒复核一次 |
| 断开恢复 | 删除插件创建且未被手改的条目；还原接管前已有的条目；用户手改过的条目保留并告警 |
| 诊断 | `status`、`models`、`sync`、`doctor`、`setup`、`serve`、`restore-client` |
| 可选热刷新 | 默认关闭；显式开启后，模型目录变化会自动通知已打开的 Trae 窗口 |

插件不写 Trae 的 SQLite，不改 `storage.json`，不做登录、token 刷新或账号切换。它只读取本机已登录的 Trae 会话，用来调用 Trae 自己的模型管理接口。

---

## 2. 与 Trae CN 插件的区别

这是**独立实现**的国际版适配器，不是把 CN 插件改个名字。两者可以在同一台机器上并存，因为 agent id、配置目录、端口和数据目录都不同。

| 维度 | 本插件（Trae 国际版） | Trae CN 插件（参考实现） |
| --- | --- | --- |
| 目标客户端 | Trae International 3.6.20（已核对） | Trae CN 3.4.18 / 3.4.20（上游记录） |
| Agent id / 显示名 | `trae-intl` / `Trae (International)` | 使用 CN 自己的 agent id |
| 配置目录 | `~/.config/magpie-trae-intl` | `~/.config/magpie-trae` |
| 回环桥端口 | `3499` | `3498` |
| Trae 用户数据 | `%APPDATA%/Trae`、`~/.trae` | `%APPDATA%/Trae CN`、`~/.trae-cn` |
| 安装发现 | 卸载注册表 + 常见目录，校验 `providerCode=i18n`、`packageType=TRAE_I18N` | 固定 CN 安装目录与 CN 标识 |
| 模型 API 主机 | 按账户区域选择国际版主机（SG / normal / US / USTTP） | CN 主机 |
| 目录接口 | 国际版 `batch_get_detail_param` 响应形状；`model_list` 仅作诊断回退 | CN 的 batch 形状与 5 个 function |
| 凭据白名单 | Trae 3.6.20 的两个 DLL 与 `out/main.js` 哈希 | Trae 3.4.18 / 3.4.20 的哈希 |
| 客户端热刷新 | **默认关闭**，显式开启，可还原 | 默认开启 |
| 取消竞态补丁 | 不实现 | 仅 3.4.18 的可选脚本 |

> 不要把 CN 插件的 `managed-models.json`、`connection.json` 或 `client-backups` 复制到本插件的配置目录。两套配置格式和账号绑定不通用。

---

## 3. 工作方式

```text
Magpie 宿主
  │ 写入（插件只读）
  ▼
~/.config/magpie-trae-intl/connection.json
  │
  │  读连接信息 + 本机 Trae 登录态
  ▼
同步器 ── HTTPS ──▶ Trae 账户 / 模型管理 API
  │                   /api/ide/v1/{batch_get_detail_param,
  │                   add_custom_model, update_custom_model}
  ▼
Trae 账户中的自定义模型（显示名以 " · Magpie" 结尾，base_url 指向本机桥）
  │
  │ Trae 原生客户端发起聊天
  ▼
127.0.0.1:3499/v1/chat/completions
  │  校验回环来源、Host、回环标记、模型白名单
  │  把 Authorization 换成 connection.json 中的 Magpie gatewayKey
  ▼
本机 Magpie 网关 → 上游模型
```

三个关键点：

1. **模型选择权留在 Trae**。`connect()` 只把 Magpie 的模型清单和能力写给宿主，不返回默认模型或默认思考档位。
2. **Magpie 密钥不进入 Trae 云端模型配置**。默认（`native`）情况下，Trae 的模型记录里只放回环标记的原生封套；真正的 `gatewayKey` 只由宿主写入 `connection.json`，桥读入内存后只发往本机 Magpie。
3. **目录以 Trae 账户服务为准**。插件不直接改 Trae 的本地数据库；每次写操作都先落恢复日志，再调接口，再回读确认。

---

## 4. 安装

### 4.1 前置条件

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11 x64 |
| Trae | 国际版 **3.6.20**，已登录，能正常打开模型菜单 |
| Magpie | 0.1.4596（核对基线），已配置至少一个可用模型或路由组 |
| 插件运行时 | Magpie 自带的 Bun 宿主；插件无 npm 运行时依赖 |
| 直接运行 CLI / 测试 | Node.js **20 或更高** |

插件会读取 Trae 的安装目录来确认版本和 DLL 哈希。未在白名单中的构建会**失败关闭**：不注册模型、不派生密钥、不修改客户端。

### 4.2 安装插件

推荐直接从 GitHub 安装：

```powershell
magpie plugin add github:not502/magpie-agent-trae-intl
```

也可以从本地仓库目录安装（适合开发调试）：

```powershell
cd <仓库目录>
magpie plugin add .
```

`magpie plugin add <本地目录>` 是**就地加载**，不会把包复制到插件缓存；移动或删除仓库目录后插件会失效（从 GitHub 安装则没有这个限制）。安装后可以运行下面的命令确认安装记录（不同 Magpie 版本的输出字段可能不同）：

```powershell
magpie plugin --json
```

添加、移除、更新或开关插件会重启 Magpie 宿主；如果 Magpie 正在运行，按提示重新打开。

### 4.3 在 Magpie Agent 页启用

1. 打开 Magpie。
2. 进入 **Agent** 页面（有的版本称为“智能体”或“接入”）。
3. 找到 **Trae (International)**，打开接入开关。
4. 如果模型列表较长，展开页面底部的“显示其余”区域再选择。
5. 如果页面提供模型/路由组选择，确认要暴露给 Trae 的条目；保持 Magpie 运行。

启用后，Magpie 宿主会把网关地址、网关密钥和模型清单写入：

```text
~/.config/magpie-trae-intl/connection.json
```

该文件由 Magpie 写入，插件只读。不要手工编辑，也不要把它的内容发到 issue、聊天或日志里（其中包含 `gatewayKey`）。

### 4.4 首次重启 Trae 的时机

**首次启用后，完整退出并重新启动 Trae 一次。** 这一步让 Trae 重新拉取账户侧的自定义模型列表。仅关闭窗口不一定等于退出进程；请从托盘/任务栏确认 Trae 已退出。

之后：

| 场景 | 是否需要重启 Trae |
| --- | --- |
| 首次启用插件 | 重启一次 |
| 首次开启客户端热刷新 | 重启一次（让补丁在启动时加载） |
| Trae 升级后重新安装热刷新 | 重启一次；升级通常也会覆盖 `out/main.js` |
| 之后在 Magpie 中增删模型 | 重新加载 Trae 窗口即可；开启热刷新后由插件自动通知 |
| 修改端口或配置目录 | 重新同步后重新加载窗口；必要时重启 |
| 运行 `restore-client` 之后 | 重启一次，让原入口文件生效 |

模型目录同步本身不需要重启 Trae；重启只影响 Trae 是否重新读取模型列表。

### 4.5 在 Trae 中选择模型

打开 Trae 的模型菜单，选择名称以 **` · Magpie`** 结尾的条目。例如 Magpie 中名为 `Example Model` 的模型会显示为：

```text
Example Model · Magpie
```

说明：

- Magpie 的 Agent 页显示 **Trae (International)**；Trae 模型菜单里显示的是带 ` · Magpie` 后缀的模型条目。也就是说，**Trae (International) 是 Magpie 侧的接入名称，不是 Trae 菜单里的模型名前缀**。
- 显示名最长 64 个字符。模型名很长时，后缀可能被截断，但仍可从 Magpie 的 Agent 页确认对应关系。
- 模型条目由 Trae 账户侧保存，不依赖本机 SQLite 缓存；保留时间由 Trae 账号服务决定，直到插件断开/卸载并完成撤回。

---

## 5. 模型能力

插件从 Magpie 传入的模型条目读取能力字段，写入 Trae 的自定义模型配置：

| Magpie 字段 | 写入 Trae 的字段 | 规则 |
| --- | --- | --- |
| `context` | `config_detail.model_hyper_params.prompt_max_tokens` | 仅当数值 > 0 时写入；0 或缺失表示不声明 |
| `output` | `config_detail.model_hyper_params.max_tokens` | 仅当数值 > 0 时写入 |
| `images` | `config_detail.multimodal` | 转为布尔值 |
| `efforts` | `thinking_enable` + `reasoning_param` | 去掉 `default` 后仍有档位时 `thinking_enable=1`，并写入 `reasoning_param = {parameter:"reasoning_effort", values:["default", ...档位]}`；否则为 `0` 且不带该参数 |
| `name` | `display_name` | 追加 `" · Magpie"`，截断到 64 字符 |
| `id` | `model_name` | 作为 Trae 的模型标识 |
| — | `config_detail.max_turn` | 固定 `500` |

聊天请求经过桥时，`stream`、`tools`、图片内容和 `reasoning_effort` 都原样保留；桥不转发入站头，只向上游发送 `gatewayKey` 鉴权头和必要的 `content-type`/`content-length`/UA/`accept`。因此：

- 图片、工具、思考能力**最终取决于所选上游模型**，不是插件凭空增加的。
- 上游的限流、余额不足、套餐到期和参数错误会按原状态码/错误体返回，插件不改写。
- 如果 Magpie 没有提供 `context` / `output`，Trae 侧不会显示对应上限；这不代表模型真的没有上下文。
- 如果 `efforts` 只有 `default` 或为空，Trae 侧会关闭思考档位声明。

---

## 6. 目录同步与热刷新

### 6.1 同步节奏

- 插件每 **5 秒**检查一次 `connection.json`。
- 连接内容没有变化且距上次检查不到 **60 秒**时跳过，避免频繁调用 Trae 账户接口。
- 连接内容变化（启用、断开、换模型、换端口）会触发一次同步。
- 同步失败时，`sync-status.json` 会写成 `{ "state": "pending", "code": "<错误码>" }`；后续 tick 会重试。连接内容变化时通常是下一个 5 秒 tick；空闲重试仍受 60 秒间隔限制。
- 写操作顺序固定为：**先写 pending 恢复日志 → 调云端 → 回读确认 → 清 pending 并落账**。响应丢失时，下次同步按日志精确收敛，不重复创建、不误删。

### 6.2 热刷新（可选，默认关闭）

默认不修改 Trae 安装目录。**不开启热刷新也能正常使用**；只是目录变化后需要手动重新加载 Trae 窗口。只有在显式开启后，插件才会：

1. 校验 `<Trae 安装目录>/resources/app/out/main.js` 的 SHA-256 是否在允许表中；不在则拒绝，**第一次写之前就停止**。
2. 把原文件备份到 `~/.config/magpie-trae-intl/client-backups/<版本>/main.original.js`。
3. 把 `src/refresh-notifier.cjs` 复制为 `out/magpie-model-refresh.cjs`。
4. 在 `out/main.js` 末尾（`//# sourceMappingURL` 之前）追加一段动态 `import()` 加载语句。
5. notifier 在 Trae 主进程中每 1 秒读取 `sync-status.json`，目录修订号变化时向已打开的窗口发送 Trae 原生的模型变更通知。

开启方式（二选一）：

```powershell
# 方式一：写入 Magpie 的插件 options，然后重启 Magpie 宿主
magpie plugin options <插件名或目录名> '{"clientRefresh":true}'

# 方式二：从终端启动 Magpie 时设置环境变量
set MAGPIE_TRAE_INTL_CLIENT_REFRESH=1
```

开启后首次需要重启 Trae 一次。关闭热刷新不能只把选项改回 `false`：已写入的加载语句仍在，必须执行 `restore-client` 并重启 Trae。

**为什么默认关闭：** 3.6.20 的 `out/main.js` 只做过临时副本的 `node --check` 语法检查，没有在真实安装目录运行过。补丁失败不会影响桥和目录同步；`restore-client` 始终可用。

---

## 7. 断开、卸载与恢复

### 7.1 断开接入

1. 在 Magpie 的 **Agent** 页面关闭 **Trae (International)** 的接入开关。
2. 保持 Magpie 运行，等待插件完成撤回。用 `node cli.mjs status` 查看 `sync.models` 变为 `0`；`sync.state` 通常是 `disconnected`（取决于宿主如何清空 `connection.json`）。最终以 Trae 菜单中本插件条目消失为准。如果从未同步过，可能没有 status 文件。
3. 如果开启过热刷新，执行 `node cli.mjs restore-client`，然后重启 Trae。
4. 确认 Trae 模型菜单中不再有本插件写入的条目。

断开时插件只处理恢复日志中记录的模型：

| 条目来源 | 行为 |
| --- | --- |
| 插件创建、未被手改 | 从 Trae 账户删除 |
| 接管了用户已有配置、未被手改 | 还原接管前的配置（含名称、地址、状态等） |
| 用户后来手改过 | **保留**，并在 `sync-status.json` 的 `warnings` 中记录 `model_edited_in_trae` |
| 云端已不存在 | 从恢复日志中移除，不再报错 |

### 7.2 卸载插件

**先断开，再卸载。** 推荐顺序：

1. 按 7.1 完成断开，确认撤回完成（`sync.models=0`，Trae 菜单中的条目消失）。
2. 如果开启过热刷新，执行 `restore-client` 并重启 Trae。
3. 在 Magpie 的插件列表中移除本插件（`magpie plugin off <仓库目录>` 可停用；移除入口以当前 Magpie 版本为准）。
4. 确认不再需要恢复日志后，才删除 `~/.config/magpie-trae-intl`。

不要在断开完成前删除配置目录：`managed-models.json` 是撤回 Trae 模型的唯一依据；`client-backups/` 是恢复 `out/main.js` 的唯一备份。

如果已经先删除了配置目录，插件无法自动删除或还原它曾经管理的 Trae 模型，需要在 Trae 的模型管理中手动清理带 ` · Magpie` 的条目。

### 7.3 退出补偿

Magpie 宿主退出时，插件会尝试启动一个分离的 `restore.mjs` 进程；它只在“桥已断开 + 恢复日志存在”时补做一次释放。该进程失败不会影响下次启动，pending 日志会在下次插件启动时继续处理。

---

## 8. 诊断命令

在仓库目录执行（如果包已通过其他方式把 bin 放到 PATH，也可以直接用 `magpie-trae-intl`）：

```powershell
node cli.mjs status
node cli.mjs models
node cli.mjs sync
node cli.mjs doctor
node cli.mjs setup
node cli.mjs serve
node cli.mjs restore-client
```

| 命令 | 作用 | 输出 | 退出码 |
| --- | --- | --- | --- |
| `status`（默认命令） | 请求 `GET http://127.0.0.1:<port>/health`，2 秒超时，并校验响应中的 `name` 为 `magpie-trae-intl` | 脱敏的 health JSON | 0；桥不在线为 1 |
| `models` | 带本地回环标记请求 `GET /v1/models` | 模型数组（id、名称、能力字段） | 0；桥不在线为 1 |
| `sync` | 立即执行一次目录同步 | 白名单化后的同步结果或 `{ "error": "<code>" }` | 0 / 1 |
| `doctor` | 只读环境报告：产品版本、安装来源、区域、模型 API 主机名、会话布尔值、凭据可用性、目录策略、补丁状态、同步摘要 | JSON，**不含 token/key** | 0 / 1 |
| `setup` | 打印安装与首次重启提示 | 文本 | 0 |
| `serve` | 前台运行回环桥（不启动同步器） | `listening on 127.0.0.1:<port>` | 0 / 1 |
| `restore-client` | 撤销可选的热刷新补丁 | `{state, version, changed, backup, updatedAt}` | 0 / 1 |

端口优先级：

- 插件入口：Magpie 传入的 `options.port` > 环境变量 `MAGPIE_TRAE_INTL_PORT` > `3499`
- CLI：`--port <n>` > `MAGPIE_TRAE_INTL_PORT` > `3499`

`status` 的 health 里，常用字段：

- `connected`：`connection.json` 是否存在且符合契约。
- `sync.state`：`synced` / `disconnected` / `pending` / `unknown`。
- `sync.models`：当前期望的模型数量。
- `sync.code`：最近一次失败的机器码。
- `sync.warnings`：`{model, code}` 数组，最多 50 条。
- `requests` / `lastRequest`：桥转发计数和最近一次请求摘要（模型 ID、状态、是否流式、工具数、图片数、耗时；**不含消息内容**）。
- `received` / `lastInbound`：入站请求计数和最近一次路由摘要（不含 `/health`）。
- `rejected` / `lastRejection`：被拒绝的请求计数和状态码/机器码。

`doctor` 的 `clientRefresh` 只会是 `off`、`installed` 或 `unsupported`；`sync` 只显示状态、数量和修订号。它不会打印安装绝对路径，只给出来源枚举（`env` / `registry` / `fallback`）。

---

## 9. 端口与配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 桥监听地址 | `127.0.0.1:3499` | 只监听回环，不对局域网开放 |
| 配置目录 | `~/.config/magpie-trae-intl` | 固定路径；由 Magpie 宿主按 agent 描述符写入，不能用环境变量改到别处 |
| 安装目录覆盖 | 自动发现 | 可用 `MAGPIE_TRAE_INTL_APP` 指向安装目录或 `resources/app` |
| 凭据模式 | `native` | `MAGPIE_TRAE_INTL_CREDENTIAL=plaintext` 仅用于诊断，不建议日常使用（见 [`docs/USAGE.md`](docs/USAGE.md) 5.2） |
| 热刷新 | 关闭 | `options.clientRefresh` 或 `MAGPIE_TRAE_INTL_CLIENT_REFRESH=1` |

修改桥端口后，Trae 中已注册模型的 `base_url` 仍是旧端口，直到下一次同步把它更新为新端口。修改后重新加载 Trae 窗口；必要时重启 Trae。不要同时运行两个本插件实例或两个 Magpie 宿主争用同一端口。

---

## 10. 常见错误码

错误码会出现在 `status` 的 `sync.code`、`sync-status.json`、`sync` 命令输出或 Magpie 的 stderr 中。按处理阶段整理的速查表见 [`docs/USAGE.md`](docs/USAGE.md#9-错误码速查)。

| 错误码 | 含义 | 首先做什么 |
| --- | --- | --- |
| `trae_not_signed_in` | Trae 未登录，或登录信息里没有 token/userId | 在 Trae 中重新登录，完全退出后重开 |
| `trae_sign_in_expired` | JWT 已过期（或无法解析 `exp`） | 重新登录 Trae；插件不会自行刷新 token |
| `trae_device_unavailable` | 本机登录态中找不到唯一的设备键 | 重新登录；仍失败时检查 Trae 用户数据是否被清理 |
| `trae_session_unreadable` | `storage.json` 缺失、不可读或不是合法 JSON | 确认 Trae 已完成首次登录并能正常使用 |
| `trae_codec_unsupported` | 登录信息的编码格式不是已知格式 | 通常是客户端版本变化；升级插件前不要手工改 `storage.json` |
| `trae_installation_unavailable` | 找不到 Trae 安装、`Trae.exe`、`product.json` 或 DLL | 用 `MAGPIE_TRAE_INTL_APP` 指向国际版安装目录 |
| `trae_product_not_international` | `product.json` 不是国际版（`providerCode` 非 `i18n`） | 检查是否误指向 Trae CN；改用国际版目录 |
| `trae_platform_unsupported` | 非 Windows 平台 | 本插件仅支持 Windows 10/11 x64 |
| `trae_credential_version_unsupported` | Trae 版本不在 DLL 允许表 | 使用已核对的 3.6.20 构建；其他构建需重新测量后适配 |
| `trae_credential_build_unsupported` | DLL 整文件 SHA-256 不匹配 | 重新安装官方 3.6.20；不要混用被修改的 DLL |
| `trae_credential_profile_unknown` | DLL 中的标记不唯一或前缀不完整 | 版本/构建不符，失败关闭；不要手动猜密钥 |
| `trae_credential_unavailable` | `native` 模式下无法派生凭据 | 检查安装目录与 DLL 哈希；不要自动降级为明文 |
| `trae_credential_cache_unreadable` | 本地凭据缓存无法读取 | 备份后删除 `local-credential.json`，下次同步会重建 |
| `trae_client_refresh_build_unsupported` | `out/main.js` 哈希不匹配或版本不在允许表 | 不安装热刷新；桥和同步仍可用；`restore-client` 恢复 |
| `trae_client_refresh_backup_invalid` | 备份文件哈希不匹配 | 不要用未知备份覆盖；重新安装 Trae 或联系维护者 |
| `sync_busy` | 另一个同步进程持有锁 | 等待当前同步结束；不要并行运行两个 Magpie 宿主 |
| `sync_status_unavailable` | health 读不到/损坏 `sync-status.json` | 检查配置目录写权限；重新同步一次 |
| `trae_account_changed` | 恢复日志属于另一个 Trae 账号 | 切回原账号并断开；不要跨账号复用配置目录 |
| `trae_pending_model_edited` | 待恢复的写操作发现条目被手改 | 先还原 Trae 中的条目，或按 USAGE 的紧急步骤清理 pending |
| `trae_model_*_unverified` | 写入后回读未确认（create/update/delete/restore） | 保留 pending，下一次同步会重试；检查 Trae 模型列表 |
| `trae_catalog_unknown` | 目录响应形状不认识 | 通常是客户端版本变化；先运行 `doctor`，不要连续重试 |
| `trae_api_<code\|status>` | Trae 接口返回业务码或 HTTP 错误 | 401/403 先检查登录；429/5xx 稍后重试 |
| `local_auth_invalid` | 桥收到的回环标记不正确 | 检查是否混用了 CN 插件的配置；重新同步模型 |
| `trae_gateway_required` | Magpie 未提供网关地址或密钥 | 在 Magpie 中配置网关后重新启用接入 |

`model_edited_in_trae` 和 `managed_model_removed_in_trae` 是**警告**，不会让同步失败；它们出现在 `sync.warnings` 中。

---

## 11. 隐私与安全边界

### 11.1 读取了什么

| 数据 | 位置 | 用途 |
| --- | --- | --- |
| Trae 登录态 | `%APPDATA%/Trae/User/globalStorage/storage.json` | 解码本机会话，取 token、userId、deviceId、区域和过期时间；**只用于调用 Trae 自己的模型管理接口** |
| 客户端版本与主机表 | `<Trae 安装目录>/resources/app/product.json` | 校验国际版、选择模型 API 区域、生成请求头 |
| DLL 哈希与内置材料 | `<Trae 安装目录>/resources/app/modules/ai-agent/{harness,ai_agent}.dll` | 派生 AES-256-GCM 封套密钥；整文件哈希必须命中允许表 |
| 连接信息 | `~/.config/magpie-trae-intl/connection.json` | 由 Magpie 写入；桥读取 `gatewayKey` 和模型白名单，同步器读取模型清单 |

插件**不登录、不刷新 token、不切换账号、不写 `storage.json`**，也不读取 Trae 的 SQLite 模型缓存。

### 11.2 不落盘、不打印、不外发的内容

- JWT / refreshToken
- userId、deviceId、邮箱、账户信息
- Magpie `gatewayKey` 的副本
- DLL 派生的 key、salt、AAD
- 模型明文 `ak` / `sk`
- 聊天消息内容

token 只在内存中用于向 Trae 账户接口发请求，**不会发给 Magpie**。桥只把 `gatewayKey` 发给 `connection.json` 中指定的**本机**网关。

`managed-models.json` 的 `before` 会保存服务器返回的 `ak` 原值（正常为原生封套，不是 Magpie 网关密钥）；该文件仍按敏感文件处理，见 §11.4。

### 11.3 桥的边界

- 只监听 `127.0.0.1`，不接受非回环来源。
- 收到任何带 `Origin` 头的请求直接 403，挡住浏览器页面。
- 校验 `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]` 加端口，挡住 DNS rebinding。
- 要求 `Authorization: Bearer <回环标记>`；标记可以是被 Trae 原生封套包裹的，也可以是明文（仅 `plaintext` 模式）。
- 只允许 `/v1/models` 和 `/v1/chat/completions`，只转发 `connection.models` 白名单中的模型。
- 不转发任何入站头（cookie、Trae 云端 token、转发链等）；只向上游发送 `gatewayKey` 鉴权头和必要的 `content-type`/`content-length`/UA/`accept`。
- 上游地址必须是回环地址、路径为 `/v1`，且端口不能等于桥端口。

回环标记（`src/constants.mjs` 中的 `LOCAL_TOKEN`）是**公开常量，不是上游密钥**。真正的边界是“只监听回环 + Origin/Host 校验 + 模型白名单 + 只向本机 Magpie 发送 gatewayKey”。同一用户下的其他本机进程仍然可以调用桥，这一点与 CN 插件相同。

### 11.4 写了什么

| 文件 | 内容 | 是否敏感 |
| --- | --- | --- |
| `~/.config/magpie-trae-intl/connection.json` | 宿主写入的 `{version,baseURL,gatewayKey,models}` | **是**，含 `gatewayKey`；插件只读 |
| `~/.config/magpie-trae-intl/managed-models.json` | 恢复日志：模型 ID、接管前配置、指纹、pending | **是**，`before` 可能含服务器返回的加密 `ak` 封套 |
| `~/.config/magpie-trae-intl/local-credential.json` | 用本机 DLL 派生密钥加密的回环标记 | **是**，按敏感文件处理；不是 Magpie 网关密钥 |
| `~/.config/magpie-trae-intl/sync-status.json` | 状态、数量、警告、修订号 | 可能含模型 ID；不含消息内容 |
| `~/.config/magpie-trae-intl/client-refresh-status.json` | 热刷新通知回执 | 否 |
| `~/.config/magpie-trae-intl/client-backups/<版本>/main.original.js` | 可选热刷新前的 Trae 入口原文 | 否，但属于 Trae 客户端代码，不要分发 |
| `~/.config/magpie-trae-intl/model-sync.lock` | `{pid,key}` | 否 |

配置目录按 `0700` 创建，文件按 `0600` 写入（Windows 上的权限语义受文件系统限制）。

### 11.5 诊断输出

- `doctor` 只输出版本、来源枚举、区域、主机名、布尔值、状态摘要，不输出 token、userId、deviceId、gatewayKey、模型 `ak`/`sk`。
- `status` 的 health 不返回完整模型列表，但 `lastRequest.model`、`sync.warnings[].model` 会包含模型 ID；这些不是聊天内容。
- `models` 按设计打印模型 ID 和名称。
- `restore-client` 会打印备份文件路径（位于本机配置目录下）；分享输出前请自行去掉。
- 插件没有遥测，不访问除 Trae 账户 API 和本机 Magpie 网关以外的地址。

**不要分享** `connection.json`、`managed-models.json`、`local-credential.json`、`storage.json` 或任何包含 token/key 的日志。报告问题时只提供版本、错误码和 `doctor`/`status` 中已脱敏的字段。

---

## 12. 验证边界与测试

### 12.1 已核对

| 项目 | 结果 |
| --- | --- |
| 目标环境 | Windows 10/11 x64、Trae 国际版 3.6.20、Magpie 0.1.4596 |
| 静态契约 | 模块签名、固定常量、错误码、状态文件 schema 与 `docs/design/interfaces.md` 对齐 |
| 离线测试 | `npm test`：113 项测试全部通过（本次核对运行） |
| 语法检查 | `npm run check`：32 个文件通过 `node --check` |
| 隐私扫描 | `npm run privacy`：44 个文件、15 条规则通过（7 处测试假值按策略放行） |
| 打包白名单 | `npm run pack:check`：`npm pack --dry-run` 列出 23 个文件（运行时 + 许可/说明），无 docs/tests/scripts/状态文件 |
| 真实账号验收 | 2026-11-21：`batch_get_detail_param` 200、`add_custom_model` 创建成功且回读一致（AK 原样回显、`client_connect:true` 由服务端自动标记）、二次同步无重复写、断开后删除并回读确认；测试模型清理干净，账户其余模型快照零变化 |
| 客户端哈希 | 3.6.20 的 `harness.dll`、`ai_agent.dll`、`out/main.js` 哈希来自本机只读测量，见 `src/constants.mjs` |
| 热刷新语法 | `out/main.js` 追加动态 `import()` 在临时副本上通过 `node --check`（调研阶段） |

> `docs/design/architecture.md` §13.3 记录的是骨架阶段的 9 项检查；上表是当前实现重新运行的结果。两者不矛盾，后者覆盖了前者。

### 12.2 未验证

- 端到端**聊天**未验收：目录 CRUD 已通过真实账号验证，但“在 Trae 中选中模型发一条消息”需要 Magpie 网关与 Trae 客户端同时在线，尚未执行。
- **没有**在真实 Trae 安装目录运行可选热刷新补丁；只做了临时副本的语法检查。
- **没有**验证其他 Trae 构建、Trae CN、macOS、Linux。
- **没有**验证非空 `sk`、`model_list` 的 GET body 等开放问题；这些在 `docs/design/architecture.md` 第 14 节列出。
- 测试使用合成的 DLL、登录 blob、连接文件和假密钥，不读取真实凭据。

### 12.3 失败关闭

- 非 Windows：`trae_platform_unsupported`，不会注册模型或派生凭据（本插件不提供 macOS/Linux 支持）。
- 版本/哈希不在允许表：不注册模型、不派生密钥、不改客户端。
- 找不到唯一标记：`trae_credential_profile_unknown`，不猜算法。
- 客户端入口哈希不匹配：不写热刷新补丁。
- 运行时错误只暴露白名单机器码，不把上游响应体或文件内容带进错误消息。

---

## 13. 文档与许可

- [`docs/USAGE.md`](docs/USAGE.md)：逐步操作、故障排查、错误码速查。
- [`docs/design/architecture.md`](docs/design/architecture.md)：数据流、状态机、失败模式、验证边界。
- [`docs/design/interfaces.md`](docs/design/interfaces.md)：模块签名、状态文件 schema、错误码总表。
- [`THIRD_PARTY.md`](THIRD_PARTY.md)：`src/vendor/trae-client-codec.mjs` 的来源与改动范围。
- [`ASSET_NOTICE.md`](ASSET_NOTICE.md)：`assets/trae.svg` 来自 Trae（国际版）官方物料，版权归 Trae / 字节跳动所有，仅在标识与互操作目的下使用。

代码使用 [MIT License](LICENSE)。Trae、Magpie 及相关名称/商标归各自权利人所有；本项目是非官方适配器，不代表任何官方授权或背书。

---

## 开发

不需要安装 npm 运行时依赖。Node.js 20+ 可运行离线检查：

```powershell
npm test          # node --test "test/**/*.test.mjs"
npm run check     # node --check 所有项目 .js/.mjs/.cjs
npm run privacy   # 扫描凭据与本机绝对用户路径
npm run pack:check# 检查 npm 发布白名单
```

测试夹具只使用合成数据和明显假值；不要用真实 `storage.json`、真实 DLL 派生结果或真实 `gatewayKey` 替换测试夹具。
