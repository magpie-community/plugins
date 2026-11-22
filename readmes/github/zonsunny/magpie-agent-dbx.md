[简体中文](README.md) | [English](README.en.md)

# DBX · Magpie Agent

让 DBX 直接使用 Magpie 网关里的模型。装上插件后，Magpie 的 Agent 页会出现 **DBX**；选一个模型就会写入 DBX 的 AI 配置，断开连接会还原成写入前的默认项。

目标版本 **DBX 0.6.x**（桌面端，macOS / Windows / Linux）。

---

## 特性

- **写入 DBX 真正读取的库**：同步目标是 `dbx.db` 里的 `ai_configs` / `app_state`，不改 DBX 源码。
- **只动 Magpie 这一行**：用固定 id `magpie` 的 openai-compatible 配置；你自己加的模型和密钥不会被覆盖。
- **断开即还原**：记下写入前的默认配置和当前对话模型，断开或卸载后还原。
- **OpenAI 兼容网关**：`endpoint` 写成 Magpie 的 `/v1`，`apiStyle` 为 `completions`。
- **跨平台数据目录**：macOS `~/Library/Application Support/com.dbx.app`，Windows `%APPDATA%\com.dbx.app`，Linux `$XDG_DATA_HOME/com.dbx.app`；也认 `DBX_DATA_DIR`。

---

## 安装

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/zonsunny/magpie-agent-dbx/main/install.sh | sh
```

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/zonsunny/magpie-agent-dbx/main/install.ps1 | iex"
```

也可以在 Magpie → **Plugins** 里添加：

```text
github:zonsunny/magpie-agent-dbx
```

或：`magpie plugin add github:zonsunny/magpie-agent-dbx`

---

## 快速上手

### 前置条件

- 本机已安装 **Magpie**，网关在 `127.0.0.1:3425` 正常响应。
- 本机已安装 **DBX**，并至少打开过一次（这样才会生成 `dbx.db`）。
- Magpie 中至少已添加一个可用模型。

插件加载时会建立链接 `~/.config/magpie/dbx-home` → DBX 数据目录，Magpie 靠它检测 DBX。

### 步骤

1. **体检**：`node tools/doctor.mjs`（需要 Node ≥ 22.5）。确认找到了 `dbx.db`。
2. **安装插件**，然后打开 Magpie（让插件宿主把上面的链接建好）。`magpie ls` 应能列出 DBX。
3. **在 Magpie 里选模型**：Agents 页 → **DBX** → 模型。
4. **重启 DBX**。DBX 启动时才从 SQLite 加载 AI 配置，内存里的列表不会自动刷新。
5. 在 DBX 的模型列表里选 **Magpie**，即可走本地网关。

断开：`magpie dbx default`，再重启一次 DBX。

---

## 常用命令

| 操作 | 命令 |
| :--- | :--- |
| **安装前体检** | `node tools/doctor.mjs` |
| **安装插件** | `magpie plugin add github:zonsunny/magpie-agent-dbx` |
| **查看已检测到的 agent** | `magpie ls` |
| **查看 / 切换 DBX 模型** | `magpie dbx` / `magpie dbx <model>` |
| **断开并还原** | `magpie dbx default` |
| **删除插件** | `magpie plugin rm magpie-agent-dbx` |
| **运行测试** | `npm test` |

---

## 架构

DBX 把 AI 配置存在 SQLite 里，Magpie 的 agent 沙箱不能写数据库，所以插件拆成两段：

```text
index.mjs 加载时
    │  找 $DBX_DATA_DIR，否则找本机 DBX 数据目录里的 dbx.db
    ▼
~/.config/magpie/dbx-home  →  真实数据目录（给 Magpie 做检测）

Magpie Agents 页选中模型
    │
    ▼
dbx.agent.mjs（Magpie 沙箱）
    │  只能写 JSON
    ▼
~/.config/magpie/dbx-agent.json
    │
    ▼
index.mjs（Magpie 的 Bun 插件宿主，约 2s 轮询一次）
    │  写入 / 还原 dbx.db
    ▼
ai_configs 行 id=magpie
  provider=openai-compatible
  endpoint=<Magpie /v1>
  apiKey 留空（避免触发 DBX 的数据安全迁移）
app_state.ai_chat_selection_v1.active → 该行 + 当前模型
    │
    ▼
重启 DBX 后从 SQLite 加载
    ▼
本地 Magpie 网关  http://127.0.0.1:3425/v1
```

断开时删除 `id=magpie` 这一行和对应的 `connection_secrets`，并把默认配置、当前对话模型还原成连接前的值。

---

## 故障排查

- **`magpie ls` 没有 DBX**：先打开 Magpie，让插件宿主建好 `~/.config/magpie/dbx-home`，再跑一次 `node tools/doctor.mjs`。
- **DBX 里看不到 Magpie**：必须重启 DBX。它把 AI 配置缓存在内存里。
- **自定义数据目录**：给 **Magpie 进程**设置 `DBX_DATA_DIR`（只在终端里 export 不会被 Magpie 继承）。
- **不要手改** `~/Library/Application Support/com.dbx.app/dbx.db`。断开请用 `magpie dbx default`。

---

## 许可

MIT。图标来自本机已安装的 DBX.app。
