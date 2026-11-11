# Kelivo × Magpie Agent

把 [Kelivo](https://github.com/Chevey339/kelivo) 接入 [Magpie](https://usemagpie.ai)，让它出现在 Magpie 的 **Agents** 页面：在 Magpie 里给 Kelivo 选一个模型，插件会把 Magpie 网关、网关密钥和模型目录写进 Kelivo 自己的 `kelivo.db`；断开或移除插件时，原样还原。

> Kelivo 的 Provider、助手和模型都存在 SQLite 里，不是文本配置文件。所以这个插件由两半组成：Magpie 的 Agent 模块负责“选模型”，Bun 插件宿主负责在 Kelivo 关闭时写数据库。

## 功能

- Magpie 的 Agents 页出现 **Kelivo** 一行，可从 Magpie 的所有模型里选一个。
- 自动在 Kelivo 里创建/接管名为 **Magpie** 的 Provider：
  - 地址：Magpie 网关（通常是 `http://127.0.0.1:3425/v1`）
  - 密钥：Magpie 为 Kelivo 单独生成的网关密钥
  - 模型：Magpie 给该 Agent 的完整模型目录（含上下文长度、视觉、工具、推理等级、价格）
- 把 Kelivo 的默认模型和所有助手的模型指向 Magpie。
- 断开时还原：
  - 原来没有 Magpie Provider：删除插件创建的 Provider
  - 原来已有 Magpie Provider：恢复原来的内容、排序和密钥
  - 恢复默认模型和每个助手原来的模型
  - 助手行只改 `chatModelProvider` / `chatModelId` 两个字段，其余内容保持原样（包括 Dart 写出的 `7.0` 这类数字格式）
- 插件被移除时，退出钩子会在 Kelivo 已关闭的情况下把数据库还原。

## 要求

| 项目 | 要求 |
| --- | --- |
| Magpie | 支持 Agent 插件和 Bun 插件宿主的版本（本插件在 0.1.3336 上测试） |
| Kelivo | 1.3+ 桌面版，使用 SQLite `kelivo.db`。旧的 Hive 存储（没有 `kelivo.db`）不支持 |
| 系统 | Windows / macOS / Linux 桌面。手机上的 Kelivo 不在本机，不能由本机插件直接管理 |

## 安装

仓库已公开，可以直接从 GitHub 安装：

```
magpie plugin add Eddyxyc/magpie-agent-kelivo
```

或打开 Magpie → **Plugins** → **Add a plugin** → 选择这个仓库。

本仓库带有 `magpie-plugin` topic，GitHub 索引后也会出现在 **Plugins → Discover → Unofficial**（未经审核的第三方插件区）。

开发时也可以用本地目录：

```
magpie plugin add D:\Plugin\Magpie_Kelivo
```

本地目录方式改代码后，在 Magpie 的 Plugins 里把插件关掉再打开即可重新加载 Bun 部分。

安装后：

```
magpie plugin        # 插件应为 on
magpie kelivo        # 应显示 Kelivo 一行
```

## 使用

1. **先启动一次 Kelivo**，让它创建 `kelivo.db`，然后**退出 Kelivo**。
2. 打开 Magpie → **Agents** → **Kelivo** → 选择一个模型。
3. 插件检测到 Kelivo 已关闭后写入数据库。重新打开 Kelivo：
   - 模型选择器里会出现 **Magpie** Provider；
   - 当前助手和默认模型已经指向你选的模型。
4. 之后在 Magpie 里换模型也可以；重新打开 Kelivo 生效。

> Kelivo 启动时读取 Provider 和助手配置，所以写入后必须重启 Kelivo。  
> 如果 Kelivo 正在运行，插件会等待；它不会在运行中改数据库，避免和 Kelivo 的内存状态互相覆盖。

## 工作方式

```
Magpie Agents 页
  └─ kelivo.agent.js（moejs，选模型、写桥接文件）
       └─ ~/.config/magpie/kelivo-agent.json
            └─ index.mjs / bridge.mjs（Bun 插件宿主，每 2 秒看一次）
                 └─ kelivo.db（provider_rows / preference_rows / assistant_rows）
```

- **桥接文件**：`~/.config/magpie/kelivo-agent.json`，只保存 `gatewayKey`、`baseURL`、`model`。
- **恢复日志**：`~/.config/magpie/kelivo-bridge-state.json`，保存被接管前的 Provider、默认模型和每个助手的原始模型。断开后删除。
- **模型目录**：插件从网关 `GET /v1/models` 读取；Magpie 的模型名、上下文、视觉、推理等级和价格会映射成 Kelivo 的模型覆盖项。目录每 5 分钟刷新一次；Magpie 的网关不可达时沿用上次目录或只保留所选模型。
- **写入条件**：Kelivo 的 `kelivo.db` 存在，并且 Kelivo 没有运行（通过它自己的单实例探测端口判断）。

### Kelivo 数据目录

插件会自动查找：

| 系统 | 默认目录 |
| --- | --- |
| Windows | `%APPDATA%\com.psyche\kelivo`（会读取 `.kelivo_storage` 跟随移动后的数据目录） |
| macOS | `~/Library/Application Support/com.psyche.kelivo` |
| Linux | `$XDG_DATA_HOME/kelivo`（默认 `~/.local/share/kelivo`） |

如果 Kelivo 使用了自定义数据目录，可以指定：

```
magpie plugin options D:\Plugin\Magpie_Kelivo "{\"dataDir\":\"D:\\\\KelivoData\"}"
```

或设置环境变量：

```
KELIVO_DATA_DIR=D:\KelivoData
# 或者直接指定数据库
KELIVO_DB=D:\KelivoData\kelivo.db
```

`magpie plugin options` 会重载插件宿主，选项立即生效。

## 注意

- **只管理桌面端**。手机 Kelivo 的数据库不在 Magpie 所在电脑上；如果要在手机上用 Magpie，需要在 Magpie 里开启局域网共享，然后手动把 Provider 加到手机 Kelivo。
- **会覆盖所有助手的模型**。连接期间，Kelivo 里每个 `assistant_rows` 的 `chatModelProvider`/`chatModelId` 都指向 Magpie；断开时还原。这样无论切到哪个助手都会走 Magpie。
- **不会改会话级模型**。如果 Kelivo 开启了“每个会话单独选模型”，已有会话上固定的模型仍然优先；需要的话在会话里重新选一次。
- **只写入三张表**：`provider_rows`、`preference_rows`（`selected_model_v1`）和 `assistant_rows` 的两个模型字段。不会重写聊天记录、消息或其它设置。
- **不要在连接状态下直接删除插件文件夹**。优先用 Magpie 的 Disconnect，或先 `magpie kelivo default` 再移除。直接 `magpie plugin rm` 时，退出钩子会尝试还原（Kelivo 已关闭时有效）。
- Kelivo 升级后如果改了数据库结构，插件会报 `unsupported` 或找不到表；此时先断开插件，避免留下半套配置。

## 卸载

```
magpie kelivo default
magpie plugin rm D:\Plugin\Magpie_Kelivo
```

`magpie kelivo default` 会还原 Kelivo 的 Provider、默认模型和助手模型；`plugin rm` 再移除插件。

## 排查

**Agents 页没有 Kelivo**

插件安装后，Agent 定义会在 1 秒内重新加载；但已经打开的 Magpie 窗口可能还显示旧列表。关掉 Magpie 窗口再打开（或退出 Magpie 托盘后重新启动）即可。

可以用命令行确认：

```
magpie ls        # 应出现 Kelivo 一行
magpie kelivo    # 显示 Kelivo 的配置文件和当前模型
```

如果 `magpie ls` 有 Kelivo 而窗口里没有，就是窗口缓存，重启窗口即可。

**查看插件状态**

```
magpie plugin
magpie kelivo
```

在插件目录里直接跑一次桥接（需要 Bun；Magpie 自带的 Bun 也可以）：

```
bun bridge.mjs
```

它会打印：

- `not connected`：没有连接
- `waiting for Kelivo to close`：Kelivo 正在运行，等它退出
- `waiting for Kelivo's database (start Kelivo once, ...)`：找不到 `kelivo.db`
- `Kelivo was updated`：已写入
- `Kelivo was put back`：已还原

Magpie 的日志里，本插件以 `kelivo:` 开头。

## 开发与测试

```
bun test
```

测试覆盖：新建 Provider、幂等、换模型、恢复原 Provider、恢复助手、Kelivo 运行时不写入、退出时同步还原、模型目录映射、三平台路径。

## License

MIT
