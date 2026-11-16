# @magpie-community/agent-pi-desktop

把 **PI-Desktop** 变成 magpie Agents 页上的一行：在 magpie 里给它选一个模型，PI-Desktop 就用 magpie 的网关和这个模型。

**English:** Add PI-Desktop to magpie's Agents page. Pick a magpie model there and PI-Desktop uses magpie's loopback gateway and that model, with no PI-Desktop restart (refresh its model picker or start a new session).

> 社区包，不是 magpie 官方组件。测试基于 magpie 0.1.4266 与 PI-Desktop 0.23.0-beta.1；其他版本可能可用，但未逐版验证。
>
> 发布信息：仓库 `magpie-community/plugins` 的 `packages/agent-pi-desktop`；如果你从自己的 npm scope 发布，把 `package.json` 的 `name`、`repository`、`homepage`、`bugs` 换成实际值。

## 功能

- 在 magpie 的 **Agents** 页添加 **PI-Desktop**（内部 id `pi-desktop-app`，别名 `pi-desktop`、`pidesktop`）。
- 在 magpie 里选中某个模型后，自动把网关地址、模型列表和默认模型同步进 PI-Desktop 的 SQLite。
- 不需要重启 PI-Desktop：重新打开设置页/模型选择器，或直接开一个新会话即可。
- 支持 PI-Desktop 正在运行时写入：短事务、`busy_timeout`、忙锁重试，并在第一次写库前自动备份。

## 前置条件

- 已安装 magpie，并且版本支持 Agent 插件（`magpie agents` 能列出插件声明的 agent）。
- 已安装 PI-Desktop，数据目录存在（默认 `~/.pi-desktop`，Windows 下是 `C:\Users\<你>\.pi-desktop`）。
- 不需要单独安装 Bun：magpie 的插件宿主需要时会自行准备。

## 安装

详见 [INSTALL.md](./INSTALL.md)。最短路径：

```bat
magpie plugin add "C:\path\to\magpie-plugin-pi-desktop"
magpie agents
```

`magpie agents` 里应出现 **PI-Desktop**。然后在 magpie 的 **Agents** 页打开它的开关，选一个模型；几秒内同步完成，去 PI-Desktop 里刷新模型列表或开新会话。

插件文件夹方式安装后不要移动目录；要换位置请重新 `plugin add`。`plugin rm` 也认文件夹路径，不认包名。

## 写入哪些文件

### 旁路文件

`~/.pi-desktop/magpie-agent.json`（JSON；magpie 在缺失时创建并维护）：

```json
{
  "model": "provider/model-id",
  "modelName": "显示名称",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "magpie 给这个 agent 的网关密钥",
  "models": [
    {
      "id": "provider/model-id",
      "name": "显示名称",
      "context": 1000000,
      "output": 64000
    }
  ]
}
```

- `model` / `modelName`：magpie 选中的模型 id 和显示名。
- `baseUrl`：`gateway.v1`，以 `/v1` 结尾。
- `apiKey`：magpie 为该 agent 单独签发的网关密钥。**文件是明文的**，权限取决于系统/用户目录 ACL；不要把它贴到 issue、日志或截图里。
- `models`：magpie 提供给该 agent 的全部模型。
- `connect()` 不写时间戳，避免模型列表未变时产生无意义改动。

### PI-Desktop 数据库

`sync.mjs` 是包里的 Bun 模块，由 magpie 的插件宿主加载。它启动一个 watcher：

- 加载后约 500ms 同步一次；
- 之后每 2 秒检查旁路文件的 hash + mtime/size，变了才同步；
- 每 10 秒做一次心跳：把 PI-Desktop 运行期间可能被关掉的 **magpie 管理的 provider** 重新启用；如果应用默认 provider 仍指向本插件的行，就把默认模型拉回当前选择的模型。用户在 PI-Desktop 里改选了别的默认 provider 时不会被抢回；状态没变时不会写库。

被写入的 `~/.pi-desktop/pi.sqlite` 字段：

| 表 / 字段 | 来源 | 行为 |
| --- | --- | --- |
| `providers` 行 | `baseUrl` / `model` | 先找固定 id `magpie-pi-desktop`；其次侧车文件里显式写的 `providerId`；最后找 `base_url` 与 `baseUrl` **精确相等**的已有行。不会仅凭名字或 “127.0.0.1:3425” 子串认领 provider |
| `providers.id`（新建） | 固定值 | `magpie-pi-desktop`；若被非本插件的行占用，依次尝试 `magpie-pi-desktop-2`… |
| `providers.name`（新建） | 固定值 | `magpie` |
| `providers.vendor_key` / `type` / `protocol` / `api_style`（新建） | 固定值 | `custom` / `openai_compatible` / `openai_compatible` / `chat_completions` |
| `providers.auth_kind` / `secret_ref`（新建） | 固定值 | `none` / `NULL`；**不写 `apiKey`** |
| `providers.base_url` | `baseUrl` | 新建时写入；只有本插件自己创建的行会随后续网关地址更新。用户已有行不改 |
| `providers.enabled` | 心跳 | 只对 magpie 管理的行（固定 id、显式 `providerId`、或 `base_url` 精确等于网关地址的行）强制设为 `1`；无关的 disabled provider 不会被打开 |
| `providers.default_model_id` | `model` | 选中的模型 |
| `providers.config_json.models` | `models` | 合并而不是覆盖：保留已有条目和相对顺序，补 `id`、`contextWindow`、`maxTokens`，来源标成 `catalog`；**选中的模型放在第 0 位**（PI-Desktop 用它当 provider 默认模型） |
| `providers.owner_plugin_id`（新建） | 固定值 | `NULL`：PI-Desktop 启动时会删掉 owner 指向未注册插件的行，因此靠固定 id 识别。更新旧版本留下的行时也会把遗留的 `owner_plugin_id` 清成 `NULL` |
| `models`（只 upsert 选中的一行） | `model`、`modelName`、`models[]` | `model_id`、`display_name`、`source='user'`、`discovery_state='published'`；已有行的 `capabilities_json`、`deprecated`、`discovery_state` 等列保留 |
| `kv`（`ns='app'`，`key='app'`） | `model` | 只改 `defaultModelId`；`defaultProviderId` 为空、指向本插件命名空间内的行、指向已不存在的行，或本次同步**新建**了 magpie 的 provider 时，一并改成当前 provider。其他键和 `updated_at` 原样保留。新建后用户在 PI-Desktop 里另选默认 provider 不会被心跳抢回 |
| `~/.pi-desktop/magpie-backups/pi.sqlite.<时间戳>.bak` | — | 每个进程第一次真正写库前做一次一致性备份，最多保留 10 份 |

**用户已有 provider 的保护**：对不是本插件创建、但被复用的行，只改 `default_model_id`、`config_json.models`，以及确有必要时的 `enabled`；不碰 `auth_kind`、`secret_ref`、`vendor_key`、`type`、`protocol`、`api_style`、`base_url`。如果这类行的 `config_json` 本身不是合法 JSON，同步会返回 `invalid-provider-config` 并保持原样，避免覆盖掉用户配置。

## 跨平台路径

PI-Desktop 的已解包主进程代码里：

```js
const INSTALLATION_DATA_DIR_NAME = ".pi-desktop";
const DEVELOPMENT_DATA_DIR_NAME = ".pi-desktop-dev";

function desktopDataDir(development = process.env.PI_DESKTOP_DEV === "1") {
  return resolveDataDir({
    override: process.env.PI_DESKTOP_DATA_DIR,
    development,
    home: homedir(),
  });
}
```

即 Windows、macOS、Linux 都等于 `path.resolve(path.join(os.homedir(), ".pi-desktop"))`，**不是**各平台不同的 `AppData` / `Application Support`。开发构建在 `PI_DESKTOP_DEV=1` 时用 `~/.pi-desktop-dev`；`PI_DESKTOP_DATA_DIR` 可整体改数据目录。

`sync.mjs` 按同样的规则取数据库路径：`PI_DESKTOP_DATA_DIR` > `PI_DESKTOP_DEV` > `~/.pi-desktop`。旁路文件默认仍在 `~/.pi-desktop/magpie-agent.json`，因为 agent 描述里的 `config` 就指向那里；需要时可用 `PI_DESKTOP_AGENT_CONFIG` 覆盖。

## 测试与调试用环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_DESKTOP_SYNC_DISABLE=1` | 不启动 watcher（测试/只调用 `syncOnce` 时用） |
| `PI_DESKTOP_DB` | 覆盖 `pi.sqlite` 路径 |
| `PI_DESKTOP_AGENT_CONFIG` | 覆盖旁路 JSON 路径 |
| `PI_DESKTOP_DATA_DIR` | 覆盖数据目录（数据库），与 PI-Desktop 本人一致 |
| `PI_DESKTOP_DEV=1` | 使用 `~/.pi-desktop-dev`（与 PI-Desktop 开发构建一致） |

`syncOnce` 的返回 `reason` 可能是：`no-config`、`config-error`、`invalid-config`、`no-model`、`invalid-base-url`、`no-db`、`no-base-url`、`invalid-provider-config`、`db-busy`、`db-error`、`unchanged`。这些情况都不会抛异常；日志里不会出现 `apiKey`。

## 关闭、卸载与还原

- **只停用这一行**：在 magpie Agents 页把 `PI-Desktop` 关掉，或选回它自己的模型。magpie 会还原 `magpie-agent.json` 里它写过的键。
- **数据库不会自动回滚**：停用/卸载插件不会删除已经写入 `pi.sqlite` 的 provider / 模型行；PI-Desktop 里仍会看到 magpie 的 provider。
- **用备份还原**：退出 PI-Desktop，把 `~/.pi-desktop/magpie-backups/pi.sqlite.<时间戳>.bak` 复制回 `~/.pi-desktop/pi.sqlite`，并删掉同目录的 `pi.sqlite-wal` / `pi.sqlite-shm`。备份是完整数据库副本，可能含会话和个人数据，请妥善保管。
- **手动清理**：在 PI-Desktop 里删除 `magpie-pi-desktop` provider（或本插件复用的那个 loopback provider）里 magpie 加的内容，并把默认 provider / 默认模型改回去。
- **卸载插件**：先关闭 Agents 页那一行，再移除插件。文件夹安装用目录路径：

  ```bat
  magpie plugin rm "C:\path\to\magpie-plugin-pi-desktop"
  ```

  只有 npm 方式安装的插件才能用包名 `magpie plugin rm @magpie-community/agent-pi-desktop`。
- `~/.pi-desktop/pi.sqlite.v*.bak` 是 PI-Desktop 自己的版本迁移备份，不是本插件的回滚点；本插件的备份在 `magpie-backups/` 下。

## 已知限制

- **id 不是 `pi-desktop`**：magpie 把 `pi-desktop` 预留给了自己的 PI-Desktop 会话集成，插件声明同名 id 会被忽略。本插件实际 id 是 `pi-desktop-app`，注册了别名 `pi-desktop` / `pidesktop`；Agents 页显示 **PI-Desktop**，`magpie pi-desktop ...` 也能用。
- **不需要重启 PI-Desktop**：`providers.list`、设置读取和新会话启动都会重新查 SQLite。已打开的设置页可能显示旧列表，刷新即可。
- **直接写 SQLite**：写库是 `sync.mjs` 的职责。它用短事务、默认 5s busy timeout 和三次退避重试来避开锁，并在第一次写库前备份。PI-Desktop 运行中写入是支持的；极端并发下仍可能遇到忙锁，watcher 会在下次心跳或文件变化时重试。
- **停用不等于回滚数据库**：见上一节。
- **密钥**：`apiKey` 只存在于明文的 `magpie-agent.json`；`sync.mjs` 不把它写进 `pi.sqlite`（provider `auth_kind='none'`，只走 loopback），也不打印到日志。备份文件里有完整数据库，仍可能包含用户自己的其他密钥引用/会话数据。
- **只有当前模型**：`own()` 返回空数组，Agents 页的选择器只列 magpie 当前选中的模型，不展示 PI-Desktop 自己的模型目录。
- **不启用 Effort**：`effort: false`，PI-Desktop 侧没有对应的推理强度字段。
- **不跨 WSL**：`wsl: false`，只在 Windows/macOS/Linux 本机使用。
- **不清理旧行**：如果网关端口变化，旧 loopback provider 不会被删除；本插件会新建/复用自己的固定行。需要时手动清理旧行。
- **models 表只写当前模型**：完整模型列表在 `providers.config_json.models` 里。

## 开发与测试

```bash
cd magpie-plugin-pi-desktop
bun test                     # 26 tests
cd ..
bun test/verify.mjs          # 独立验证脚本，位于工作区根目录
bash test/sandbox-plugin.sh  # 沙箱安装/加载测试
```

所有测试只使用 `research/pi.sqlite.copy` 的临时副本和临时 HOME/数据目录，不会打开或修改真实 `~/.pi-desktop/pi.sqlite`。
