# snowapp-magpie-agent

把 **Snow App** 变成 magpie Agents 页面上的一行 Agent：在 magpie 里给它选一个模型，Snow App 的 API 档案就会自动指向 magpie 网关；断开时恢复你原来的配置。

> 这是 **magpie 的 Agent 插件**，不是 Snow App 的面板插件。Snow App 本体不需要安装任何东西。

## 为什么需要 Bun 侧同步

magpie 的 Agent 插件（`agent.mjs`）运行在 moejs 里，只能把键值写进一个 JSON / YAML / ENV 文件，拿不到 Node、文件和 SQLite。而 Snow App 的 API 配置在：

```text
~/.snowapp/snowapp.db  (SQLite, WAL)
  └─ api_configs       (API 档案表)
```

所以这个包由两部分组成：

| 部分 | 运行位置 | 作用 |
| --- | --- | --- |
| `agent.mjs` | magpie（moejs） | 声明 Snow App 这个 Agent；`connect()` 把网关地址、key、模型和模型限制写进 `~/.snowapp/magpie-agent.json` |
| `hooks.mjs` + `sync.mjs` | magpie 的 Bun 插件宿主 | 监听上面那个 JSON，把选择写进 Snow App 的 `api_configs`；断开时恢复原档案 |

`hooks.mjs` 是 magpie 的异步网关钩子入口（只做透传），它同时负责启动同步器。包没有 `main`/`exports`，所以 GitHub 发现页会把它正确归到 Agent；magpie 启动并读取供应商列表时，Bun 宿主会加载它；因此选完模型后不需要额外启动任何进程。

## 安装

```bash
# 本地目录
magpie plugin add /path/to/snowapp-magpie-plugin
```

如果 `magpie` 不在 PATH（macOS 装了应用但没装 CLI 时常见），用应用内 **设置 → 插件 → 添加插件**，目录填这个仓库路径即可。

> 第一次使用时如果 Agents 页面没有 Snow App，先启动一次 Snow App（让 `~/.snowapp` 出现），再刷新 Agents 页面。

安装后刷新 **Agents** 页面，应该出现 **Snow App** 一行。

## 使用

1. 在 Agents 页面打开 Snow App 的「接入」开关。
2. 在下拉里选一个 magpie 的模型（例如 `openai/gpt-5`、`deepseek/deepseek-chat`，或某个路由组）。
3. 插件会：
   - 在 Snow App 的 `api_configs` 里创建 / 更新一个名为 `magpie-agent` 的档案（显示名 `Magpie (Agent)`），
   - 把 `base_url` 设为 `<gateway>/v1`、`api_key` 设为这个 Agent 专属的 magpie key、`request_method` 设为 `chat`，
   - 把选中的模型写进 `advanced_model` 和 `basic_model`，
   - 把这个档案设为当前启用档案。
4. Snow App 的新请求会立即使用它（后端每次请求都从数据库读取当前档案）。**API 设置页**可能还显示旧的启用状态，刷新或重开设置页即可。
5. 选回 Snow App 自己的模型 / `default`，或关掉开关，插件会删除自己创建的 `magpie-agent` 档案，并恢复接入前的启用档案；如果你原本就有一个叫 `magpie-agent` 的档案，会原样还原。

## 写入与恢复

- 档案名：`magpie-agent`
- 档案来源：`source = "magpie-agent"`
- 接入时激活：`is_active = 1`
- 首次写入前会把要覆盖的档案和当时的启用档案备份到：

  ```text
  ~/.snowapp/magpie-agent-state.json
  ```

- 断开时恢复备份，然后删除该状态文件。
- 只修改 `api_configs` 中与本次接入相关的行（`magpie-agent` 档案和启用状态），不动 Snow App 的其他表、其他档案或设置。

## 生效时机

- **新请求**：Snow App 原生层每次请求都会重新读 `api_configs`，所以切换后发出的下一条消息就会走新档案。
- **设置页**：界面自己缓存了档案列表，刷新 / 重开设置页后才会显示新的启用档案。
- 如果 Snow App 正在运行，SQLite 的 WAL 模式允许并发写入；插件设置了 5 秒 `busy_timeout`。

## 跨平台（Windows / Linux / macOS）

Snow App 的 API 数据库三端都在 **用户主目录** 下的 `.snowapp`，不是 Windows 的 `%APPDATA%`，也不是 Linux 的 XDG 目录（见 Snow App 源码 `native/src/storage/paths.rs` 的 `dirs_next::home_dir()`）：

| 系统 | 数据库 |
| --- | --- |
| macOS | `/Users/<user>/.snowapp/snowapp.db` |
| Linux | `/home/<user>/.snowapp/snowapp.db` |
| Windows | `C:\Users\<user>\.snowapp\snowapp.db` |

插件用 `os.homedir()` + `path.join()` 拼接，所以三端分隔符正确；还会额外探测：

- macOS App Sandbox：`~/Library/Containers/com.snow.app/Data/.snowapp/snowapp.db`
- Linux Flatpak：`~/.var/app/com.snow.app/.snowapp/snowapp.db`
- `SNOWAPP_DB_PATH`：显式指定数据库路径（测试、便携安装）
- `SNOWAPP_MAGPIE_HOME`：显式指定配置目录；设置后只在该目录下找数据库，不会回退到真实 HOME

其他平台细节：

- Windows 的 `rename` 不能直接覆盖已有文件，状态文件写入有 unlink + rename + 直接写入的 fallback；
- SQLite 使用 `PRAGMA busy_timeout = 5000`，Snow App 正在运行时也能排队写入；
- CI 在 `ubuntu-latest` / `windows-latest` / `macos-latest` 三平台跑同一套单测。

> 说明：没有在真实 Windows / Linux 的 Snow App 实例上跑过（只在 macOS 实机验证）。如果 Snow App 跑在 Flatpak / Snap 等会重映射 HOME 的沙箱里，`agent.mjs` 的 `dir: "~/.snowapp"` 可能检测不到 Agent 行；这种情况把 `dir` 改成实际目录，或用 `SNOWAPP_DB_PATH` 指定数据库。

## 限制与注意事项

- **先断开，再卸载插件**：如果在接入状态下直接卸载，Bun 同步器会随宿主停止，`magpie-agent` 档案可能留在 Snow App 里。到 Agents 页面关掉开关即可恢复。
- Snow App 必须已经安装（`~/.snowapp/snowapp.db` 存在）。未安装时插件会安静等待，安装后再写入。
- 如果你手动改过 `magpie-agent` 档案，下一次切换模型时会被覆盖；断开时恢复的是首次接入前的备份，不是你的手动修改。
- 插件只读取 / 写入 `api_configs` 中名为 `magpie-agent` 的那一行（接入前若有同名档案会备份）；不读取对话、其他档案或系统设置。
- 网关 key 会写进 Snow App 的本地数据库，和 magpie 为其他 Agent 写入的 key 一样，只在本机使用。

## 发布

这个包走 magpie 的 GitHub 社区通道：仓库根目录有 `package.json`，给仓库打上 GitHub topic **`magpie-plugin`**，就会出现在 magpie 的 **插件 → 发现 → 非官方插件 · GitHub**。完整步骤与社区 registry 的可选项见 [PUBLISHING.md](PUBLISHING.md)。

## 开发

```bash
bun test        # 同步逻辑与 agent 描述的单测
npm run check   # 语法检查 + 单测
```

目录：

```text
agent.mjs               magpie Agent 描述 + connect()
hooks.mjs               Bun 钩子入口，启动同步器
sync.mjs                JSON → Snow App SQLite 的同步与恢复
test/agent.test.mjs
test/sync.test.mjs
icon.png                Snow App 官方图标（resources/icon@4x.png）
package.json            magpie.agent / magpie.hooks / magpie.icon 清单
```

## 图标

`icon.png` 来自 Snow App 官方资源 `resources/icon@4x.png`；`agent.icon` / `magpie.icon` 内嵌的是同一图标的 256px 版本（`resources/icon.png`）的 data URI，避免 magpie 为本地图标发起网络请求。

## License

MIT
