# Cursor · Magpie Bridge（增强版）

让普通版 Cursor 使用 **Magpie** 中配置的模型与路由组：模型菜单只列出 Magpie 目录，隐藏 Cursor Auto 入口，保留 Cursor 原有登录与 Tab 补全。

- **当前版本**：`0.2.35`（本地增强版）
- **适配范围**：Cursor 3.28.x ～ 3.31.3（已实测）；控制台会读取本机实际版本，超出范围时标记「未验证」并建议先运行自检
- **平台支持**：macOS（Apple Silicon 与 Intel x64，LaunchAgent 守护；Intel 引擎为 `bin/darwin-x64/cursor-magpie-bridge`）、Windows x64（启动文件夹守护，`bin/win32-x64/cursor-magpie-bridge.exe`，无需管理员权限即可常驻；首次信任证书需一次管理员确认）与 Linux x64/arm64（systemd 用户单元守护，`bin/linux-<arch>/cursor-magpie-bridge`；证书写入 Cursor `argv.json` 与用户 NSS 库，无需 root；无 systemd 用户实例时回退为分离进程）
- **与上游的关系**：基于 [nodlles/magpie-agent-cursor-bridge](https://github.com/nodlles/magpie-agent-cursor-bridge) `v0.2.2` 与本机 fork 增补，原生核心来自 [leookun/cursor-byok v1.0.1](https://github.com/leookun/cursor-byok/tree/v1.0.1)；Linux 适配参考 [Ice0828/magpie-agent-cursor-bridge-linux](https://github.com/Ice0828/magpie-agent-cursor-bridge-linux)
- **本仓库定位**：公开增强版，GitHub topic 已标记 `magpie-plugin`；可从 Magpie 插件页安装 `github:kingchen95272025/magpie-agent-cursor-bridge-enhanced#v0.2.35`，也支持本机源码安装
- **变更记录**：[CHANGELOG.md](CHANGELOG.md)

---

## 目录

1. [介绍](#一介绍)
2. [原理](#二原理)
3. [插件使用](#三插件使用)
4. [如何开发](#四如何开发)
5. [与原版的升级点](#五与原版的升级点)
6. [致谢与免责声明](#六致谢与免责声明)
7. [变更记录](CHANGELOG.md)

---

## 一、介绍

### 1.1 它解决什么问题

Cursor 的 Agent / Composer 默认只认自家订阅与官方后端。通过 Magpie 已经可以接入多家模型提供商，但 Cursor 客户端并不会直接读 Magpie 的模型目录。

本桥接在两者之间加了一层**本地协议转译**：

- Cursor 以为自己在和官方后端对话；
- 实际请求被本机代理截获，转成 Magpie 网关的 OpenAI 兼容请求；
- 模型的返回再被翻译回 Cursor 的流式协议，渲染成正常的回复、工具调用与思考过程。

最终效果：在 Cursor 里直接选择 `Opus`、`Sonnet`、`Fable` 或任意 Magpie 模型，计费与路由全部走 Magpie。同样的模型也可以在 Cursor CLI（`cursor-agent`）中使用，见 [3.10](#310-接管-cursor-clicursor-agent)。

### 1.2 它不是什么

- 不修改 Cursor 安装包，不注入代码，不绕过登录；
- 不复制任何模型提供商的密钥，只使用 Magpie 的 Agent 网关密钥；
- 不替代 Cursor 的 Tab 补全（补全仍走 Cursor 原路径）；
- 不保证跨版本永久兼容——Cursor 的私有协议变化时需要配套更新（见 [第五节](#五与原版的升级点)）。

### 1.3 当前能力

| 能力 | 状态 |
|---|---|
| Agent / Composer 对话（含流式文本、思考过程） | ✅ |
| 工具调用循环（读写文件、执行命令、MCP） | ✅ |
| Magpie 模型目录同步（每 15 秒） | ✅ |
| 模型选择器隐藏 Cursor Auto | ✅ |
| 模型显示名短名化（`Opus` 而非三段长名） | ✅ 0.2.4 |
| 运行模式：默认 / 轻量（SQLite 不落盘） | ✅ 0.2.6 |
| Multitask 后台子代理完成后父代理接管 | ✅ 0.2.7 |
| 子代理模式：异步后台 / 同步阻塞 | ✅ 0.2.8 |
| 数据库管理：分类统计 / 分级清理 / VACUUM | ✅ 0.2.10 |
| 数据库清理前备份 / `quick_check` | ✅ 0.2.24 |
| 自动保留策略（调用日志 / 历史会话，在线分批） | ✅ 0.2.26 |
| 日志尾部 / 错误归类 / 脱敏诊断包（`data/diagnostics`） | ✅ 0.2.26 |
| Cursor 版本探测与兼容提示 | ✅ 0.2.27 |
| 分层自检（代理 / 证书 / 网关 / 模型） | ✅ 0.2.27 |
| 模型隐藏 / 搜索 / 单模型测试 | ✅ 0.2.27 |
| 最近调用与错误视图 | ✅ 0.2.28 |
| 更新检查（干净源码安装可一键升级） | ✅ 0.2.28 |
| 控制台 GitHub 仓库入口 | ✅ 0.2.29 |
| 一键停止并还原 Cursor 代理 | ✅ 0.2.31 |
| Cursor CLI（`cursor-agent`）共用同一套桥接与模型 | ✅ 0.2.33 |
| Orca 聊天接管（官方入口 + 配置兜底） | ✅ 0.2.34 |
| Orca 接管持久化与后台自动维持 | ✅ 0.2.35 |
| 参数区分组多行与 `?` 悬浮说明 | ✅ 0.2.35 |
| Cursor 3.29+ 二进制协议编码 | ✅ 0.2.3 |
| Cursor 3.27 本地循环开关回退 | ✅ 上游 0.2.2 |
| Tab 补全 / 行内补全 | 沿用 Cursor 原路径 |

---

## 二、原理

### 2.1 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Magpie                                                      │
│  Agents 页面 ──写入──▶ ~/.config/magpie-cursor-bridge/       │
│                          connection.json                    │
│  Gateway 127.0.0.1:3425/v1（OpenAI 兼容）                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ 模型目录 / 对话请求
┌──────────────────────────▼──────────────────────────────────┐
│ 后台监视器（bridge.js supervise，随登录启动）                  │
│  ├─ 每 15 秒同步 Magpie 模型目录 → effective.json            │
│  ├─ 启停原生桥接（cursor-magpie-bridge）                     │
│  └─ 备份 / 还原 Cursor 代理设置（settings-journal.json）      │
└──────────────────────────┬──────────────────────────────────┘
                           │ spawn
┌──────────────────────────▼──────────────────────────────────┐
│ 原生桥接（Rust，hudsucker）                                  │
│  ├─ 本地 TLS 代理 127.0.0.1:58160（MITM，独立 CA）           │
│  ├─ Cursor Connect/protobuf 协议解析与转译                   │
│  ├─ Agent 循环与工具调用编排                                  │
│  └─ 独立数据库 data/bridge.db（会话、调用、检查点）            │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS（经代理）
┌──────────────────────────▼──────────────────────────────────┐
│ Cursor（Electron）                                           │
│  settings.json: http.proxy = http://127.0.0.1:58160          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 请求链路

1. **接管**：后台监视器把 `http.proxy` 写入 Cursor 的 `settings.json`，并在 `settings-journal.json` 记录原始值。
2. **MITM**：Cursor 的 HTTPS 请求经 `127.0.0.1:58160` 到达桥接；桥接用本机生成的 CA（`Cursor BYOK Local CA`）终止 TLS。
3. **路由判定**：按请求路径区分处理方式：
   - 模型目录、Statsig 配置、Composer 专属 RPC → **本地生成**；
   - `BidiAppend` / `RunSSE` → **本地 Agent 引擎**；
   - 其他非 AI 请求（用量、插件市场等）→ **原样转发 Cursor 官方**。
4. **转译**：本地 Agent 引擎把 Cursor 的 `AgentRunRequest` 编译成 OpenAI Chat Completions 请求，发往 Magpie 网关。
5. **回流**：Magpie 的流式响应被翻译成 `AgentServerMessage`（文本增量、思考增量、工具调用），沿 `RunSSE` 流回 Cursor。
6. **恢复**：断开或退出时，监视器按 journal 还原代理设置；用户在期间对 `settings.json` 的其他修改会被保留。

### 2.3 Agent 循环：为什么是两个请求

Cursor 的经典 Agent 循环不是一条长连接，而是**一上一下两条流**：

```text
Cursor ──POST /aiserver.v1.BidiService/BidiAppend──▶ 桥接
         （上行：AgentClientMessage，含用户消息、上下文、工具结果）
                        │
                        ▼
              Agent 引擎（会话、检查点、工具编排）
                        │
                        ▼
Cursor ◀──POST /agent.v1.AgentService/RunSSE────── 桥接
         （下行：AgentServerMessage 流，含文本/思考/工具调用）
```

- `BidiAppend` 是**无状态追加**，带 `append_seqno` 保证顺序；
- `RunSSE` 是**服务端流式响应**，客户端持续读取直到 `turn_ended`；
- 工具调用的执行方仍然是 Cursor：桥接发出 `ExecServerMessage`，Cursor 执行后通过下一条 `BidiAppend` 回传结果。

### 2.4 两个关键的协议细节

**（1）消息编码：`data` 还是 `data_binary`**

`BidiAppendRequest` 同时定义了两个载荷字段：

```proto
message BidiAppendRequest {
  string data = 1;          // hex 编码的 AgentClientMessage（3.28 及以前）
  BidiRequestId request_id = 2;
  int64 append_seqno = 3;
  bytes data_binary = 4;    // 原始 protobuf 字节（3.29+ 默认）
}
```

Cursor 3.29+ 由客户端开关 `bidi_append_binary_encoding_disabled`（默认 **false**）控制，默认改用 `data_binary`。上游 0.2.2 只接受 `data`，因此会直接返回 `InvalidArgument`。**0.2.3 起两种编码同时接受**。

**（2）模型标识：hash 而不是 ID**

Cursor 请求里的 `requested_model.model_id` 是桥接生成的 `model_hash`（如 `4dabda0dfea1a42a`），不是 `group/opus`。桥接用 `model_configs.model_hash` 查表决定本地路由还是转发官方。

### 2.5 模型目录与显示名

- 监视器每 15 秒请求 Magpie `GET /v1/models`，变化时原子写入 `effective.json`；
- 原生桥接读取 `effective.json`，在 `AvailableModels` 响应里返回 Magpie 目录；
- 同时写入 `display_configuration`，隐藏 Cursor 内置的 Auto 入口；
- **0.2.4 起** `display_name` 只取 Magpie 模型名的第一段（` · ` 之前），tooltip 仍保留完整 ID：

| Magpie 名称 | 显示名 |
|---|---|
| `Opus · routing group` | `Opus` |
| `Sonnet · routing group` | `Sonnet` |
| `Fable · routing group` | `Fable` |
| `Qwen4-Max-Preview · Qoder CN` | `Qwen4-Max-Preview` |

### 2.6 数据与安全

```text
~/.local/share/magpie-cursor-bridge/
  agent.js、package.json          # 注册到 Magpie 的稳定插件入口
  releases/版本-随机后缀/          # 完整版本目录（含 bin/runtime）
~/.config/magpie-cursor-bridge/
  connection.json                 # Magpie 写入的私有连接配置（含网关 key）
  effective.json                  # 当前生效的模型目录快照
  installation.json               # 当前安装版本与 release 路径
  settings-journal.json           # Cursor 代理恢复记录（连接时存在）
  status.json                     # 后台运行状态
  engine.log                      # 原生桥接诊断（0600，4 MiB 轮转）
  data/ca/                        # 本机证书与私钥
  data/bridge.db                  # 会话、调用、检查点（会持续增长）
```

- 监听地址只在本机回环，不对外暴露；
- CA 与私钥仅存在本机，首次安装时请求 macOS 信任；
- 桥接只对 Cursor 域名做协议转换，其余流量原样转发；
- `bridge.db` 会记录完整会话与调用，属于敏感数据，注意备份与清理；
- **轻量模式**（控制台可切换）把 SQLite 整体放入引擎进程内存：不创建、不写入 `bridge.db`，请求转发与会话状态在进程内完整可用；引擎重启后会话历史清空，旧 `bridge.db` 保留但不再增长。

---

## 三、插件使用

> 图文版完整教程（含 Magpie 基础概念、供应商维护与真实控制台截图）见 [docs/plugin-usage.md](docs/plugin-usage.md)。
>
> 使用前请先在 Magpie 中添加供应商、测试 API Key，并在 Agents 中为 Cursor Bridge 分配模型或路由组；供应商 Key 由 Magpie 保存，本插件只使用 Magpie 的本地网关与 Agent Key。

### 3.1 前置条件

- macOS（Apple Silicon 或 Intel x64）、Windows 10/11 x64，或 Linux x64/arm64（随包产物以 glibc 2.34 为基线，即 Debian 12 / Ubuntu 22.04 及以上；OpenSSL 以 vendored 方式静态链接，无 `libssl` 运行时依赖；更老的发行版可在本机运行 `scripts/build-native-linux.sh` 原生构建；需 systemd 用户实例，无 systemd 时回退为分离进程）；
- macOS：Magpie 与 Cursor 均安装在 `/Applications`；Windows：使用默认安装位置（Magpie 在 `%LOCALAPPDATA%\Programs\magpie`，Cursor 在 `%LOCALAPPDATA%\Programs\cursor`）；Linux：Magpie 在 `PATH` 或 `~/.local/bin`、`/usr/local/bin`、`/usr/bin`，Cursor 安装位置不限；
- Magpie 中已配置至少一个可用模型；
- 无需安装 Cursor BYOK 或 Rust；各平台运行时都直接复用 Magpie 自带的 Bun。
- Linux 可选安装 `nss-tools`（Debian/Ubuntu 为 `libnss3-tools`）以获得用户 NSS 证书库导入；未安装时仍会写入 Cursor `argv.json`，不影响使用。

### 3.2 安装

从 Magpie 插件页安装（推荐）——在 **Magpie → Plugins** 添加固定版本地址：

```text
github:kingchen95272025/magpie-agent-cursor-bridge-enhanced#v0.2.35
```

安装后在终端运行一次包内初始化：

```sh
bash "$HOME/.config/magpie/plugins/node_modules/magpie-agent-cursor-bridge/setup.command"
```

本机源码安装：

```sh
cd <项目目录>
bash setup.command
```

初始化会：

1. 校验二进制摘要与版本配对（`integrity.json` 分别固定插件版本 `version` 与随包引擎版本 `engineVersion`，分平台摘要见 `platforms`）；
2. 复用已有证书，或在首次安装时生成本机 CA 并完成平台信任：macOS 请求系统授权、Windows 加入本机 Root、Linux 写入 Cursor `argv.json` 并尽力导入用户 NSS 库；
3. 把完整版本目录 stage 到 `releases/0.2.35-xxxxxx`；载荷、引擎与运行时都未变化时直接复用已有目录，各平台只保留当前激活的 release；
4. 把 `~/.local/share/magpie-cursor-bridge` 注册为本地 Magpie 插件；
5. 停止旧后台、切换服务定义（LaunchAgent / 启动文件夹 / systemd 用户单元）、启动新后台。

完成后在 **Magpie → Agents** 选择 **Cursor · Magpie Bridge** 和一个模型，再重启 Cursor。也可以直接在插件控制台的「连接模型」卡片中从 Magpie 模型目录选择并点「连接并启动」：控制台会调用 Magpie 的 agent 接口写入连接，随后自动拉起原生引擎；首次安装时连后台服务也一并启动。**未选择模型时原生引擎显示「等待连接」属于正常待机（省电）状态，不是故障**，选择模型后数秒内会变为「运行中」。

Windows x64 不必使用终端：在 Magpie 的 **Cursor · Magpie Bridge** 行菜单打开「桥接控制台」，点「启动」即可，等价于在包目录执行 `node install.js setup`。Windows 的差异：

1. 随包引擎只把 **LocalMachine Root** 里的证书视为已受信任，因此证书会加入本机「受信任的根证书颁发机构」，首次启动弹出一次 UAC 管理员确认；之后不再询问。若取消授权，控制台会提示证书未受信任。
2. 登录自启写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\local.magpie.cursor-bridge.vbs`（通过 WScript 隐藏窗口启动），不使用计划任务，普通用户即可安装与卸载。
3. 安装目录为 `%LOCALAPPDATA%\magpie-cursor-bridge`，`releases\` 下只保留当前版本，旧版本在每次「启动」后自动清理。
4. 若 Magpie 插件列表里同时登记了本仓库路径和 `%LOCALAPPDATA%\magpie-cursor-bridge` 两份，请移除其中一份；重复登记会让两个控制服务争用同一端口。安装器检测到重复时会给出提示，但不会擅自删除登记。
5. Magpie 的 Agent 沙箱在 Windows 下拿不到进程环境，`connection.json` 实际由 Magpie 展开 `~` 写入 `%USERPROFILE%\.config\magpie-cursor-bridge\`；后台会同时读取该位置与 `%APPDATA%\magpie-cursor-bridge\`，无需手动复制。后台状态、数据库与 release 仍在 `%APPDATA%` / `%LOCALAPPDATA%`。

Linux x64/arm64 同样可以在控制台点「启动」或在包目录执行 `bash setup.command`。Linux 的差异：

1. 后台由 **systemd 用户单元** `~/.config/systemd/user/local.magpie.cursor-bridge.service` 守护（`Restart=on-failure`，登录自启），日志追加到 `supervisor.log` / `supervisor-error.log`，也可用 `journalctl --user -u local.magpie.cursor-bridge` 查看。
2. 当 `systemctl --user` 不可用（容器、未启用 systemd 的 WSL、精简发行版）时，安装器**回退为分离进程**立即启动 supervisor，并保留单元文件；下次登录若 systemd 用户实例可用，会自动接管。控制台「后台服务」此时显示「ready」或「stopped」，实际运行状态以「后台监视器」的 PID 为准。
3. 证书信任全程**不需要 root**：安装器把 CA 路径写入 Cursor 的 `~/.config/Cursor/argv.json`（`certificate-authority`），并在检测到 `certutil` 时导入用户 NSS 库 `~/.pki/nssdb`；两者任一成立，随包引擎即认为 CA 已受信任。若还需系统级信任，按安装日志最后一行提示执行一次 `sudo cp ... && sudo update-ca-certificates`（Debian/Ubuntu）或 `sudo update-ca-trust extract`（Fedora/RHEL/Arch）。
4. 安装目录为 `~/.local/share/magpie-cursor-bridge`，每次 setup 只保留当前 release；旧版本在激活成功后自动清理。
5. Cursor 需要**重启一次**才能读取新的 `argv.json` 与模型目录；若模型菜单仍为空，先确认 `~/.config/Cursor/User/settings.json` 的 `http.proxy` 已由桥接写入。

> 若同时装有上游 GitHub 插件，请先移除，避免两个同名 agent 争用连接：
>
> ```sh
> magpie plugin rm github:nodlles/magpie-agent-cursor-bridge
> ```

### 3.3 连接与断开

```sh
magpie cursor-bridge group/opus     # 连接并选择模型
magpie cursor-bridge default        # 断开，Cursor 恢复原代理
```

断开后 Cursor 回到原来的模型来源；重新连接即可再次接管。连接状态可在 Magpie → Agents 或 `status.json` 查看。

### 3.4 切换模型

- 在 **Cursor 模型菜单** 或 **Magpie Agents 页面**切换；
- Magpie 中当前选中的模型会排在列表首位；
- 新增模型后桥接会在 15 秒内同步，Cursor 菜单可能需要重新打开才能看到；
- 已有聊天若仍显示 Auto，手动改选一次即可。

### 3.5 控制台（Agent 行菜单）

Magpie 的代理卡片内部是内置 UI，插件无法把控件插进那张卡片。本插件通过 Magpie 的 **Agent 行菜单**提供入口（Magpie 0.1.3830 实测）：

- 在 **Cursor · Magpie Bridge** 行的把手（或右键）选择「桥接控制台」；侧栏「插件」组也会出现同名页面。
- Agent 行与侧栏页使用 Cursor 官方图标（`ui/cursor.svg`）。
- 打开后跳转到本机控制台 `127.0.0.1:3580`（首次进入的引导页可修改端口）。
- `magpie.actions` 的菜单项对全部 Agent 行生效；从其他 Agent 行打开时会提示该入口只服务于 Cursor · Magpie Bridge。

控制台提供：

- **启动**：macOS / Linux 运行 `bash setup.command`（校验包、stage 新版本、切换 LaunchAgent 或 systemd 用户单元）；Windows 运行 `install.js setup`（写入启动文件夹、结束旧后台、启动新后台）
- **停止**：停止 supervisor 与原生引擎、还原 Cursor 代理设置；不卸载服务、不删除数据，再次点「启动」即可恢复
- **状态**：macOS / Linux 为 `bash setup.command status`，Windows 为 `install.js status`，同时刷新运行概览
- **重启**：终止 supervisor 与原生引擎后重新执行「启动」；macOS 额外 `launchctl bootout`，Linux 额外 `systemctl --user stop`
- **运行模式**：默认模式 / 轻量模式。轻量模式让原生引擎使用进程内存中的 SQLite（shared-cache），不写 `data/bridge.db`；切换后 supervisor 在 2 秒内自动重启引擎，当前对话可能中断一次。轻量模式会沿用上次的代理端口（端口占用时回退随机），避免 Cursor 因端口变化而需要重启。
- **可编辑参数**：按「运行与引擎 / 接管与集成 / 模型与日志 / 数据保留」四组多行排列，每项旁的 `?` 悬浮显示说明、点击可固定（再点或点击空白处关闭）。参数包括模型目录同步间隔（默认 15 秒）、网关断线容错（默认 60 秒）、引擎日志上限（默认 4 MiB）、调用日志保留（默认 7 天，0=不自动清理）、历史会话保留（默认 0=不自动清理）、接管 Orca 聊天（默认开启），写入 `~/.config/magpie-cursor-bridge/bridge-settings.json`。运行模式与同步间隔、容错在下一轮循环生效（模式变更会重启引擎）；日志上限在下次后台启动时生效；保留策略由 supervisor 在后台分批执行，不中断对话、不执行 VACUUM，结果写入 `retention.json` 并显示在控制台「自动清理」一栏。`orcaTakeover` 是持久意图：保存后立即应用，Orca 运行中则在它退出后由 supervisor 自动完成，重跑 setup 也遵循该值。
- **模型显示名、顺序与隐藏**：控制台独立的「模型显示名」折叠卡片（默认收起，展开才读取模型目录）中，每个模型一行：拖动行首 `⋮⋮` 调整顺序、勾选「菜单」决定是否在 Cursor 中显示、填写显示名、行内「保存」只更新该行名称；「测试」向 Magpie 网关发送一条极短请求并显示延迟；顶部搜索框可按模型 ID 或名称过滤；底部「保存全部」一次保存名称、顺序与隐藏项。配置写入 `bridge-settings.json` 的 `modelNames`、`modelOrder` 与 `modelHidden`，只影响传给引擎的目录，模型 ID、路由、计费与连接语义不变；当前选中的模型即使被隐藏也始终保留，避免路由失效。保存后 supervisor 更新 `effective.json`，引擎热更新模型目录，约 2–4 秒生效。
- **快捷入口**：配置目录、数据目录、诊断目录、`engine.log`、`supervisor.log`、`supervisor-error.log`、安装目录、插件目录。
- **日志与诊断**：折叠卡片可读取三类日志的尾部（100–1000 行），按证书、端口、网关、协议、连接停滞、启动超时、代理改动归类并给出操作建议；「导出诊断包」把状态、设置、版本、平台、保留结果与脱敏日志写入 `data/diagnostics/diagnostics-<时间>.json`，并返回文件路径。
- **最近调用**：折叠卡片读取 `llm_calls` 最近 25/50/100 条，显示时间、模型、状态、耗时、token（入/出/总）与错误摘要；可切换「只看错误」，错误内容脱敏；只读查询走 `created_at_ms` 索引，不扫描请求正文。
- **版本更新**：控制台「检查更新」读取 GitHub latest Release，显示当前与最新版本；干净源码安装可「升级并重启」（`git fetch` + `--ff-only` 合并 tag + `setup.command`），其他安装方式显示 `magpie plugin update` 等手动命令。检查结果缓存 10 分钟；GitHub API 不可达时给出错误，不影响桥接运行。
- **分层自检**：同卡片中的「运行自检」依次检查插件版本、Magpie 连接、引擎 PID、代理端口、MITM 证书链路、网关目录，以及可选的极短模型请求（默认勾选，可能计费）。结果以检查表显示并给出失败层；它覆盖到模型层，Cursor 的 Bidi/RunSSE 原生往返仍由构建侧的 `magpie_smoke` 示例覆盖。
- **Cursor 版本**：控制台读取本机 Cursor 安装版本，与已实测范围 3.28.x–3.31.3 比较；超出范围显示「未验证」并提示先运行自检。

控制服务只监听 `127.0.0.1:3580`（可在引导页修改，约 2 秒切换），每次启动生成随机口令，并校验 `Host` 与 `Origin`。它由 Magpie 插件宿主拉起，**后台桥接停止时仍能点「启动」**。`magpie web`（浏览器远程）下无法访问本机环回地址，控制台不可用。顶部「刷新页面」右侧的 GitHub 链接通过本机默认浏览器打开本项目仓库；地址取自 `package.json` 的 `homepage` / `repository`，未配置时自动隐藏。

> 从旧版本升级后，需要在 Magpie 插件页**关闭再开启**本插件（或重启 Magpie），宿主才会加载新的 `control/host.js`、页面与菜单清单。

### 3.6 状态与日志

```sh
bash setup.command status    # 输出 status.json 原文
```

典型的 `status.json`：

```json
{
  "version": "0.2.35",
  "state": "connected",
  "mode": "lite",
  "engineMode": "lite",
  "model": "group/opus",
  "models": 4,
  "proxy": "http://127.0.0.1:58160",
  "backend": "http://127.0.0.1:53902",
  "pid": 32668
}
```

`state` 取值：`connected` / `disconnected` / `paused` / `error` / `stopped`。`mode` 是控制台保存的运行模式，`engineMode` 是当前引擎实际使用的模式；两者短暂不一致表示切换尚未完成。

排障时优先查看：

- `~/.config/magpie-cursor-bridge/engine.log`（原生桥接诊断；0.2.7 起默认记录 `info` 级事件，可用 `RUST_LOG=cursor_server=debug` 提高详细度）
- `~/.config/magpie-cursor-bridge/supervisor-error.log`
- `~/Library/Application Support/Cursor/logs/<时间戳>/`（Cursor 侧）

### 3.7 更新

```sh
cd <项目目录>
bash scripts/build-native.sh      # 重新编译原生桥接（约 3 分钟）
bash setup.command                # stage 新版本并切换后台
```

只改 Agent / JS 文件不足以替换正在运行的后台，必须重跑 `setup.command`。若 Magpie 提示 agent 已断开，执行 `magpie cursor-bridge group/opus` 重连。

### 3.8 卸载

```sh
bash setup.command uninstall
```

会停止后台、还原 Cursor 代理、从 Magpie 移除本地插件。**证书、`data/` 与恢复记录会保留**，便于日后重装。

### 3.9 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| Composer 提示 “Connection stalled” | 协议不兼容（如 3.29+ 的 `data_binary`） | 确认运行版本 ≥ 0.2.3 |
| 模型菜单为空 | 目录未同步 / Magpie 网关不可达 | 查 `status.json`、`engine.log`，确认 Magpie 在运行 |
| 提示未登录 / `ERROR_NOT_LOGGED_IN` | 非 AI 请求被转发到 Cursor 官方，属预期 | 忽略；不影响 Agent 对话 |
| 修改代理后桥接暂停 | 检测到外部程序改动 `http.proxy` | 在 Magpie 中断开后重新连接 |
| 更新后仍是旧行为 | 后台未切换 | 重跑 `setup.command`，必要时重启 Cursor |
| Agent 行菜单没有「桥接控制台」 | 插件宿主仍加载旧清单 | 在 Magpie 插件页关闭再开启本插件，或重启 Magpie |
| 从其他 Agent 行打开控制台被提示 | `magpie.actions` 对全部 Agent 行生效 | 从 Cursor · Magpie Bridge 行打开，或直接用侧栏插件页 |
| 控制台打不开 / 端口被占用 | 控制服务未启动或端口冲突 | 在引导页修改控制端口后重试；确认插件处于开启状态 |
| 控制台没有样式、按钮无响应 | 沙箱页的 CSP 拦截了外链资源 | 升级到包含 CSP 修复的版本；旧页面强制刷新或重新打开 |
| 控制台提示「控制口令无效」或「控制服务不可达」 | 页面在控制服务重启（插件重载、端口切换、升级）前打开，内联令牌已过期 | 点「刷新页面」或重新打开控制台；新版页面会自动重载一次 |
| Linux 控制台显示「当前平台不支持后台服务」 | 运行在非 Linux/macOS/Windows 平台，或包内缺少对应架构引擎 | 确认 `uname -m` 为 x86_64/aarch64，且 `bin/linux-<arch>/cursor-magpie-bridge` 存在并通过 `integrity.json` 校验 |
| Linux 启动失败：`requires an already trusted CA` | 引擎未在 `argv.json`、用户 NSS 库或系统 anchor 中看到该 CA | 重跑 `bash setup.command`；确认 `~/.config/Cursor/argv.json` 的 `certificate-authority` 指向 `~/.config/magpie-cursor-bridge/data/ca/ca.crt`，然后重启 Cursor |
| Linux 启动回退为分离进程 | 当前会话没有可用的 systemd 用户实例（容器/WSL/精简系统） | 属预期回退；若希望登录自启，启用 systemd user manager 或执行 `loginctl enable-linger "$USER"` 后重跑 setup |
| Linux 控制台「后台服务」显示 ready 但未运行 | 单元已写入但尚未由 systemd 启动 | 点「启动」，或执行 `systemctl --user enable --now local.magpie.cursor-bridge` |
| Windows 启动失败：`Access is denied` 或证书未受信任 | 证书未加入本机 Root，或取消了 UAC 授权 | 重新点「启动」，在管理员确认窗口选择「是」；确认 `certmgr.msc` 的「受信任的根证书颁发机构」中存在 `Cursor BYOK Local CA` |
| Windows 启动失败：引擎退出码 1 / `requires an already trusted CA` | 旧版安装器只写入了当前用户证书存储，随包引擎只认本机存储 | 升级到本版本后重新点「启动」；首次会弹出一次 UAC |
| Windows 日志出现 `EADDRINUSE` 或 agent id 重复 | Magpie 插件列表登记了两份本插件 | 在 Magpie 插件页保留一份，移除 `%LOCALAPPDATA%\magpie-cursor-bridge` 或仓库路径的其余登记 |
| Windows 控制台「后台服务」显示未加载 | 登录自启文件被删除，或从未完成「启动」 | 检查 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\local.magpie.cursor-bridge.vbs`，重新点「启动」 |
| Intel Mac 提示缺少引擎 | 包内缺少 `bin/darwin-x64` 产物 | 使用 v0.2.31+ 版本；或在 Apple Silicon 上运行 `scripts/build-native-macos-x64.sh` 重新构建并更新 `integrity.json` |
| Cursor CLI 仍走官方后端 | 未通过包装器启动，或桥接断开 | 用 `cursor-agent-bridge` 启动；确认控制台「Cursor CLI 接管」中环境文件为「已写入」 |
| Cursor CLI 提示证书错误 | 系统未信任桥接 CA，且未注入 `NODE_EXTRA_CA_CERTS` | 重跑 `bash setup.command`；使用包装器启动（会自动注入证书路径） |
| 后台被强制终止后 Cursor CLI 连不上 | `agent-env` 残留并指向已停止的代理 | 重新启动后台，或删除 `~/.config/magpie-cursor-bridge/agent-env` |

### 3.10 接管 Cursor CLI（cursor-agent）

Cursor CLI（`cursor-agent`）与 IDE 使用同一套 `agent.v1` / `BidiAppend` 协议，因此可以共用同一个桥接引擎与同一份模型目录。区别只在接管方式：CLI 不读取 Cursor 的 `settings.json`，只能通过 `HTTPS_PROXY` 环境变量进入本机代理。

setup 会自动安装 `cursor-agent-bridge`（优先 `~/.local/bin`，该目录不在 PATH 时退回安装目录的 `bin/`）：

```sh
cursor-agent-bridge --list-models
cursor-agent-bridge -p --model <模型ID> "只回复：收到"
```

包装器只做三件事：载入桥接写出的 `~/.config/magpie-cursor-bridge/agent-env`、导出 `HTTPS_PROXY` 与 `NODE_EXTRA_CA_CERTS`、启动官方 `cursor-agent`。**不会修改官方二进制**；桥接断开时 `agent-env` 会被删除，包装器自动退回直连。

控制台「Cursor CLI 接管」卡片提供安装/移除包装器、复制一次性启动命令，并显示 CLI 版本是否落在已实测范围。已实测版本：`2026.11.19`。CLI 运行时会改写 `~/.cursor/cli-config.json` 的默认模型，属正常行为，可用 `/model` 切回。

如果使用 Orca 的「启动聊天」：Orca 会直接 spawn `cursor-agent --list-models` / `cursor-agent acp`，不经过 shell，且忽略它自己的 `agentDefaultEnv` / `agentCmdOverrides`。setup 会把 `~/.local/bin/cursor-agent` 替换为桥接包装器（官方入口保留为 `cursor-agent-official`），使 Orca 聊天、终端与脚本统一接管；控制台「官方入口」可一键恢复。官方 CLI 自更新会重建入口，重跑 setup 或点控制台的「接管官方入口」即可修复。Orca 会持久缓存旧模型目录，接管后若仍显示官方模型，重启一次 Orca 即可。

Orca 自己的 `agentCmdOverrides.cursor` 作为兼容兜底，由控制台「可编辑参数 → 接管 Orca 聊天」持久管理：开启时后台会在 Orca 退出后自动写回（Orca 退出时会重写该文件），关闭时自动移除；Orca 运行中切换会在其退出后完成，setup 也读取同一设置。包装器按磁盘上实际安装的文件识别，不依赖启动进程的 PATH，因此后台服务与控制台的判断一致；包装器未安装时跳过写入。关闭只停用这层兜底，「官方入口」接管不受影响，因此控制台状态会区分「已关闭」与「已关闭 · 官方入口仍接管」。Orca 已配置自定义 cursor 命令时不会被覆盖。

**直接输入 `cursor-agent` 就接管默认开启**（可在控制台「可编辑参数」中关闭）：setup 会在 `~/.zshrc`（或 `~/.bashrc`）写入一个带 `# >>> cursor-bridge >>>` 标记的函数块，通过同名 shell 函数注入环境变量，并用 `command cursor-agent` 调用官方二进制。重新打开终端后生效；仅作用于交互式 shell，脚本与 IDE 集成不受影响。关闭开关只移除该标记块。Windows 不支持函数式接管，请使用 `cursor-agent-bridge`。

---

## 四、如何开发

### 4.1 目录结构

```text
.
├── agent.js                 # Magpie Agent 插件入口（id: cursor-bridge）
├── version.js               # 运行时版本单一来源（agent / supervisor / UA）
├── bridge.js                # 后台监视器：目录同步、启停桥接、代理接管
├── install.js               # 安装器：校验、证书、stage、注册、激活；macOS/Linux 经 setup.command 调用，Windows 的「启动」直接调用它
├── setup.command            # macOS/Linux 初始化入口（转调 install.js：setup/status/uninstall/--version）
├── control/                 # Agent 行菜单控制台：插件宿主服务 + 本机 HTTP 控制台
│   ├── host.js              # 由 Magpie 插件宿主加载，守护控制服务与端口切换
│   ├── server.js            # 127.0.0.1 控制 API：启动/状态/重启/参数/日志/诊断/自检
│   ├── diagnostics.js       # 日志尾部、脱敏与错误归类
│   ├── selftest.js          # 分层自检：代理端口、MITM 证书、网关目录、模型请求
│   ├── ui.html / ui.css / ui.js
├── ui/                      # Magpie 插件页与 Agent 行菜单入口（沙箱页）
│   ├── console.html
│   ├── console-page.js
│   └── cursor.svg           # Cursor 官方图标（Agent 行 / 侧栏页）
├── lib/
│   ├── config.js            # connection.json 校验与 Magpie 模型目录拉取
│   ├── compatibility.js     # Cursor / Cursor CLI 已实测范围与版本比较
│   ├── cursor-agent.js      # CLI 探测、agent-env 与 cursor-agent-bridge 包装器
│   ├── bridge-settings.js   # 可编辑参数（运行模式、保留策略、模型显示名/顺序/隐藏）
│   ├── supervisor.js        # 引擎启停/重启/断线容错状态机（依赖注入，可测试）
│   ├── install.js           # 版本配对、证书、release stage、LaunchAgent / systemd 单元
│   └── settings.js          # Cursor settings.json 的原子写与代理恢复
├── bin/cursor-magpie-bridge # macOS arm64 编译产物（Rust，历史布局）
├── bin/darwin-x64/          # macOS Intel 引擎
├── bin/win32-x64/           # Windows x64 引擎
├── bin/linux-x64|arm64/     # Linux 引擎（按架构分目录）
├── source.patch             # 相对上游 v1.0.1 的全部源码改动
├── source-linux.patch       # Linux 专属补丁：argv.json / NSS 用户级信任判定
├── scripts/build-native.sh  # macOS arm64：克隆上游 → 应用补丁 → cargo build → 写摘要
├── scripts/build-native-macos-x64.sh # Apple Silicon 上交叉编译 Intel x64
├── scripts/build-native-windows.sh        # macOS 上交叉编译 Windows x64
├── scripts/build-native-linux.sh          # Linux 原生构建（Linux 主机或容器内）
├── scripts/build-native-linux-docker.sh   # macOS/Linux 上用 Docker 构建 x64 + arm64
├── .github/workflows/test.yml # 三平台 CI：语法检查、测试、源码补丁校验
├── test/                    # Node 测试
├── integrity.json           # 二进制版本与 SHA-256
└── CHANGELOG.md
```

### 4.2 构建流程

`scripts/build-native.sh` 做的事：

```text
1. git clone --branch v1.0.1 --depth 1 leookun/cursor-byok
2. 校验 HEAD == 2068ab20513288e6a0289d33febe872a30608610
3. git apply source.patch
4. cargo build --release --locked -p cursor-server --bin cursor-magpie-bridge
5. 复制到 bin/，校验 --version 与 package.json 一致
6. 重写 integrity.json（version + engine + platforms.darwin-arm64）
```

Windows x64 产物在 macOS 上交叉编译：

```sh
brew install mingw-w64
rustup target add x86_64-pc-windows-gnu
CARGO_BUILD_JOBS=2 bash scripts/build-native-windows.sh
```

脚本产出 `bin/win32-x64/cursor-magpie-bridge.exe`，并写入 `integrity.json` 的 `platforms.win32-x64` 摘要。

macOS Intel x64 产物在 Apple Silicon 上交叉编译（arm64 仍由 `build-native.sh` 产出到历史路径 `bin/cursor-magpie-bridge`）：

```sh
CARGO_BUILD_JOBS=2 bash scripts/build-native-macos-x64.sh
```

脚本会安装 `x86_64-apple-darwin` target，产出 `bin/darwin-x64/cursor-magpie-bridge`，并写入 `integrity.json` 的 `platforms.darwin-x64` 摘要。Rosetta 可用时直接执行 `--version` 自检，否则回退到 `strings` 校验版本常量。

Linux x64 / arm64 产物用 Docker 从 macOS 或 Linux 构建。两个架构都在已缓存的 `linux/amd64` 容器内完成：x64 原生编译，arm64 使用 Debian 的 `aarch64-linux-gnu` 工具链交叉编译（因此只需要 Debian 源与 `static.rust-lang.org` 可达，不依赖 Docker Hub 的 arm64 镜像）：

```sh
bash scripts/build-native-linux-docker.sh                 # 默认构建 x64 + arm64
CURSOR_BRIDGE_LINUX_ARCHES=arm64 bash scripts/build-native-linux-docker.sh
```

也可以直接在 Linux 主机上构建（在目标发行版上构建即可获得与该系统一致的 glibc 基线）：

```sh
bash scripts/build-native-linux.sh
```

两者都会先应用 `source.patch`，再应用 `source-linux.patch`（含 Linux 信任判定与 vendored OpenSSL 依赖），产出 `bin/linux-<arch>/cursor-magpie-bridge` 并写入 `integrity.json` 的 `platforms.linux-<arch>` 摘要。Docker 方式默认使用 `rust:1-bookworm`（glibc 2.34），可用 `CURSOR_BRIDGE_LINUX_IMAGE` 覆盖镜像；交叉编译的 arm64 产物用 `strings` 校验版本常量，x64 原生产物直接执行 `--version`。Docker 方式使用命名卷缓存 Cargo registry 与 target；切换镜像或需要干净重建时删除 `cursor-bridge-cargo-registry-{x64,arm64}` 与 `cursor-bridge-target-{x64,arm64}` 四个卷。在 Apple Silicon 上构建 `linux/amd64` 建议在 Docker Desktop / OrbStack 中启用 Rosetta，否则会走 QEMU 模拟，耗时显著增加。

依赖：Git、Rust/Cargo、Python 3（Windows 交叉编译另需 mingw-w64；macOS x64 交叉编译需 Xcode Command Line Tools；Linux Docker 构建需 Docker）。默认 `CARGO_BUILD_JOBS=2`，可覆盖：

```sh
CARGO_BUILD_JOBS=4 bash scripts/build-native.sh
```

### 4.3 修改协议的正确姿势

**不要直接改编译产物**。所有原生改动都应落在 `source.patch` 中，流程如下：

```sh
# 1. 准备一份上游源码
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git /tmp/cursor-byok-src
cd /tmp/cursor-byok-src
git apply <项目目录>/source.patch

# 2. 直接编辑源码（例如 server/src/api/cursor/bidi.rs）

# 3. 重新生成完整补丁
git add -N .
git diff > <项目目录>/source.patch

# 4. 在全新检出上验证补丁可应用
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git /tmp/verify
git -C /tmp/verify apply --check <项目目录>/source.patch
```

改动涉及版本号时，四处必须同步：

1. `version.js` 的 `version`（运行时实际读取的版本）
2. `package.json` 的 `version`
3. `integrity.json` 的 `version`（`engineVersion` 保持不变，原生引擎源码未改动时）
4. `server/src/bin/cursor-magpie-bridge.rs` 的三处版本字符串（`--version`、Usage、User-Agent）

`verifyPackage` 会同时校验 `version.js`、`package.json`、`integrity.json` 与原生引擎版本，任一不一致都会拒绝安装；测试中的版本断言直接从 `version.js` 读取，无需手改。

### 4.4 测试

```sh
node --test test/*.test.js
```

覆盖：独立 CA 生成、版本配对与摘要、证书信任流程、release 复用与剪枝、release stage 不覆盖运行中版本、激活失败回退、代理设置恢复、配置校验、连接候选兜底、supervisor 状态机（首次连接、网关断线恢复、模式切换、目录热更新、外部改动暂停、引擎崩溃重启、在线保留策略）、数据库清理备份与 `quick_check`、在线保留策略、日志尾部/脱敏/错误归类、Cursor 版本兼容矩阵、分层自检、模型隐藏与单模型测试、最近调用字段与错误脱敏、版本比较；Linux 额外覆盖 systemd 单元、argv.json 注释保留、NSS 导入与信任标记、无 systemd 回退。

GitHub Actions 在 macOS、Ubuntu、Windows 三平台运行同一套语法检查与测试；Linux 额外安装 `sqlite3` 并校验 `source.patch` 与 `source-linux.patch` 可依次应用。

Linux 平台分支可以在 Debian 12 容器内完整验证（构建产物已在 `bin/linux-x64` 与 `bin/linux-arm64`）：

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/work" -w /work rust:1-bookworm bash -c '
  sed -i "s|http://deb.debian.org|https://deb.debian.org|g" /etc/apt/sources.list.d/debian.sources
  apt-get update -qq && apt-get install -y -qq --no-install-recommends nodejs sqlite3 libnss3-tools ca-certificates
  node --test test/*.test.js'
```

已有正常连接时，可手动验证生命周期（不会生成模型请求）：

```sh
node test/manual-lifecycle.mjs
```

### 4.5 调试

| 目标 | 方法 |
|---|---|
| 看后台状态 | `bash setup.command status`（Windows：`node install.js status`），或 Magpie → Cursor · Magpie Bridge 行菜单「桥接控制台」 |
| 看桥接诊断 | macOS/Linux：`~/.config/magpie-cursor-bridge/engine.log`；Windows：`%APPDATA%\magpie-cursor-bridge\engine.log`；控制台「日志与诊断」可直接读取尾部、查看错误归类，并把脱敏诊断包写入 `data/diagnostics/` |
| 运行分层自检 | 控制台「日志与诊断」→「运行自检」；覆盖插件版本、Magpie 连接、引擎、代理端口、MITM 证书、网关目录与可选模型请求 |
| 看最近调用 | 控制台「最近调用」卡片，或 `GET /api/calls?limit=25&errors=1`；来自 `llm_calls` 的模型、耗时、token 与脱敏错误摘要 |
| 检查更新 | 控制台顶部「检查更新」；干净源码安装可直接升级并重启，其他安装方式按返回命令手动升级 |
| 看 Linux 服务日志 | `journalctl --user -u local.magpie.cursor-bridge -f`，或 `~/.local/share/magpie-cursor-bridge/releases/<version>/supervisor.log` |
| 看最近模型调用 | `sqlite3 data/bridge.db "SELECT ... FROM llm_calls ORDER BY created_at_ms DESC LIMIT 10"` |
| 看 Agent 运行 | `data/bridge.db` 的 `runs`、`cursor_run_traces` |
| 协议解码失败 | 桥接会把原始报文写到 `$TMPDIR/bidi-dump-<seqno>.bin` |
| 验证 `data_binary` | 通过代理发送带 `data_binary` 字段的 `BidiAppend`，应返回业务错误而非 `not part of the captured protocol` |

**注意**：默认模式下 `bridge.db` 会持续增长（本机已超过 2 GB），排查时请用 `LIMIT` 限制查询范围；切换到轻量模式后不再写入，但旧文件会保留。调用日志默认保留 7 天、历史会话默认不自动清理，supervisor 会在线分批删除过期数据，但不会执行 VACUUM；需要立即回收磁盘空间请使用控制台的手动清理。控制台清理前可对非 `vacuum` 范围勾选备份：`sessions` / `all` 默认勾选，`traces` 默认不勾选；备份使用 `VACUUM INTO` 快照写入 `data/backups` 并保留最近 3 份。清理后执行 `PRAGMA quick_check` 并显示结果。

---

## 五、与原版的升级点

相对上游 0.2.2，增强版只改了三处：一个载荷字段、一段显示名处理、一处诊断转储。改动面很小，但每处都对应 Cursor 私有协议上的一个具体断点。下面按「现象 → 因果 → 机制」展开。

### 5.1 差异总览

| 项目 | 上游 0.2.2 | 增强版 0.2.35 | 机制 |
|---|---|---|---|
| Cursor 3.29+ / 3.30.20 | ❌ 30 秒后 “Connection stalled” | ✅ 正常对话 | 上行编码从 hex 文本改为原始 protobuf 字节 |
| `BidiAppend` 载荷 | 只接受 `data`（tag 1，hex） | `data_binary`（tag 4）优先，`data` 兜底 | 同一消息的两种编码，共用一个解码器 |
| 模型选择器显示名 | `Opus · routing group · group/opus` | `Opus` | 展示名与路由标识解耦 |
| 解码失败转储 | `.hex` 文本 | `.bin` 原始字节 | 3.29+ 的载荷本就不经过 hex |
| Cursor 3.27 / 3.28.x | ✅ | ✅ | 公共路径未改动 |
| 运行模式 | 仅文件库 | 默认 + 轻量（内存库） | 轻量模式不写 `bridge.db`，适合磁盘敏感或只做转发的场景 |
| Multitask 后台子代理 | 完成后不接管，子代理停在 Stopped | 完成即唤醒父代理，状态回写 Success | 完成通知进入运行时，不再当作 unsupported action 丢弃 |
| 分发方式 / 版本 | GitHub 插件页 / 0.2.2 | 本机 fork / 0.2.35 | 避免与上游 release 目录、摘要互相覆盖 |

### 5.2 0.2.7：Multitask 后台子代理完成后的接管

Cursor 的 Multitask 把子代理放到后台：父对话先结束自己的 turn，子代理完成后客户端再发一条完成通知，唤醒父代理继续。桥接在这条链路上有三处断点，叠在一起表现为「子代理停在 Stopped，父代理不再说话」：

| 断点 | 原因 | 修复 |
|---|---|---|
| 完成派发 | 客户端只在 Statsig gate `long_running_jobs` 开启时派发后台完成通知；Cursor 未登录时上游 bootstrap 401，桥接的本地 bootstrap 没有这个 gate | 本地 bootstrap 与上游 patch 两条路径都显式启用 |
| 完成通知 | 活跃流上的 `BackgroundTaskCompletionAction` 落到 unsupported 分支被忽略 | 运行中注入通知并打断当前 round；已结束则用完成通知重放父请求 |
| 状态回写 | checkpoint 永远写 `Backgrounded`，`Success / Error / Aborted` 从未写入 | 收到完成通知时按 `BackgroundTaskStatus` 更新状态与完成时间 |

**异步语义保留**：`is_background` 同时接受模型显式 `run_in_background` 意图与客户端 `SubagentSuccess.background_reason` 回报，任一为真即按后台处理。下行 `agent.v1.TaskArgs` 本身没有后台字段（3.30.20 实测），客户端是否异步执行由它自己的模式决定；两条信号取并集，异步模式不被降级。

**同步阻塞不受影响**：模型显式 `run_in_background=false` 且客户端同步完成时，两条信号都为空 → `is_background=false` → 工具结果直接回到模型循环，不经过后台状态机。

### 5.3 0.2.3：为什么 3.29+ 是“卡住”而不是报错

```text
Cursor 3.29+（gate bidi_append_binary_encoding_disabled 默认 false）
        │  BidiAppend 改用 data_binary（tag 4）装 AgentClientMessage
        ▼
旧桥接：data_binary 非空 → 返回 Protocol 错误 → InvalidArgument
        │  客户端判定不可重试，只丢弃这条上行消息
        ▼
下行 RunSSE 流仍处于打开状态，但没有 AgentServerMessage 可读
        │  30 秒无入站 → stall detector 触发
        ▼
界面提示 “Connection stalled”
```

因果的要点是**错误在上行通道，症状在下行通道**：`BidiAppend`（无状态追加）与 `RunSSE`（服务端流）是两条独立请求（见 2.3），上行失败不会关闭下行流。“stalled” 指的是下行长时间没有数据，而不是上行那一次错误；只看 Cursor 侧日志容易误判成网络或账户问题。

**修复原理：解编码与解协议分开**

```rust
let payload = if !request.data_binary.is_empty() {
    request.data_binary.clone()      // 3.29+：原始 protobuf 字节
} else if !request.data.is_empty() {
    hex::decode(&request.data)?      // 3.28 及以前：hex 文本
} else {
    return Err(Error::Protocol("BidiAppend contains no AgentClientMessage".into()));
};
```

- `data` 和 `data_binary` 承载的是**同一个** `AgentClientMessage`，区别只在外层编码（hex 字符串 vs 原始字节）。两代客户端的字段号（`1/2/5/3/4/6/7/8`）已交叉验证一致，所以正确做法是把载荷先归一到字节，再交给同一个解码器，而不是并排维护两套协议实现。
- 分支依据是**字段是否为空**，不是版本号或 User-Agent。Cursor 若把 gate 灰度关回去，`data_binary` 为空，自动落回 hex 分支；反之亦然。桥接因此对客户端的灰度回退免疫，也不需要每次升级 Cursor 后补版本判断。
- 解码失败转储改为 `.bin`：3.29+ 的载荷不再经过 hex，落原始字节可原样喂给 `protoc --decode` 复现，同时避免“转储内容 ≠ 实际载荷”。

### 5.4 0.2.4：短名只动渲染层

模型条目里有三个各司其职的字段，上游把前两个混用了：

| 字段 | 作用 | 增强版取值 |
|---|---|---|
| `display_name` | Cursor 模型选择器的主标签 | `Opus` |
| `tooltip_data` | 悬浮提示 | `Magpie / group/opus` |
| `model_id` | 请求中的 `model_hash`，决定路由与计费 | 不变 |

上游用 `"${name} · ${id}"` 生成 `display_name`，而 Magpie 的模型名本身已含 ` · routing group`，拼接后成为三段；选择器宽度有限，三段名被截断成难以辨认的前缀。`short_name()` 取第一个 ` · ` 之前的部分——Magpie 的命名约定是 `模型名 · 路由组/提供商`，第一段才是模型本名；名称为空时回退 `id`，保证标签非空。

`model_id` 参与哈希与路由查表（见 2.4），所以短名改造**只能**停在渲染层。两处原生改动（0.2.3 的解码、0.2.4 的短名）都必须重建二进制并重算 `integrity.json` 摘要，否则安装器的版本配对校验会拒绝加载（见 4.3）。

### 5.5 沿用上游、但值得说明原理的部分

- **3.27 本地循环开关**：Cursor 用 Statsig gate `agent_host_local_loop` 决定客户端走新的本地循环（`RunInferenceRunRequest`）还是经典 agent 循环。桥接在 `BootstrapStatsig` 的响应里把该 gate 置为 `false`，客户端于是继续发送桥接能解码的 `AgentRunRequest`。这是改客户端配置而非改协议：循环实现仍由客户端决定，桥接只影响选择结果。
- **隐藏 Auto**：在 `AvailableModels` 的 field 15 下发 `hide_routed_model_view = true`，并附带一个**空的** `NoButton` 子消息。空消息必须显式编码存在——protobuf 的 presence 本身就是语义，它负责覆盖客户端此前缓存的 Auto 控件；字段缺省等于不表态，客户端会沿用旧配置。
- **其余沿用**：15 秒目录同步（内容未变不重写）、端口持久化、网关 60 秒宽限、代理 journal 恢复、独立 CA。

### 5.6 未改变的部分（差异边界）

- 不修改 Cursor 安装包或二进制；
- 不改变 Cursor 的登录与账号体系；
- 不接管 Tab 补全；
- 不改变 Magpie 网关的模型路由与计费；
- 不向上游推送任何内容，本 fork 仅在本机使用。

---

## 六、致谢与免责声明

### 致谢

- 原生核心：[leookun/cursor-byok](https://github.com/leookun/cursor-byok) v1.0.1（MIT）
- 插件框架：[nodlles/magpie-agent-cursor-bridge](https://github.com/nodlles/magpie-agent-cursor-bridge) v0.2.2
- 第三方说明见 `THIRD_PARTY_NOTICES.md`

### 免责声明

本项目用于本机在 Magpie 与 Cursor 之间做协议适配。Cursor 的私有协议可能随版本变化，升级 Cursor 前建议先确认桥接版本兼容性。使用本桥接产生的模型调用费用由 Magpie 侧的配置决定。
