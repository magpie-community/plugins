# @magpie-community/agent-trae

把 **Trae**（ByteDance 的 AI IDE）作为 Magpie 的 Agent 接入：在 Magpie 里为 Trae 启用模型后，可以在插件页面预览并确认，把这些模型镜像进 Trae 的模型列表；MCP 服务器和技能也会自动接好。

English summary: Trae as a Magpie agent. Pick the models Magpie should offer Trae, preview the change on the plugin's page, confirm it, and the enabled models are mirrored into Trae's model list. It uses the plugin's own `trae-agent` sign-in and the per-agent key Magpie hands this row; it never reads Trae's local credentials or Magpie's gateway keys.

---

## 功能

- **多模型**：Agents 页的 Trae 行只有连接开关和模型列表，没有单模型下拉框。你在模型列表里保留的模型，会以 `Magpie · <模型名>` 的形式出现在 Trae 的模型选择器里。
- **先预览，再确认**：打开插件的 **Trae 模型** 页面，能看到哪些模型会添加、哪些会移除、哪些会保留；点 **镜像到 Trae…** 并确认后才写入 Trae 云端。
- **保留你自己的模型**：你在 Trae 里手动添加的模型不会被修改或删除。
- **MCP 与技能**：Magpie 资源库里的 MCP 服务器会写入 Trae 的 `User/mcp.json`；技能写入 `~/.trae/skills`。
- **不弹窗**：不启动 Trae、不使用调试端口、不打开 Trae 窗口。

## 登录

插件使用自己的 **`trae-agent`** 登录（浏览器登录，与 Trae IDE 使用同一种账号）：

```sh
magpie plugin login trae-agent
```

- 不读取 Trae 本地的登录/加密存储。
- 不读取 `plugin-auth.json` 里其他插件的条目。
- 不使用 Magpie 的网关密钥（`caller-keys.json`）；只使用 Magpie 交给 Trae 这一行的 per-agent key。

## 要求

- Magpie **0.1.3863** 或更新（使用了 Agent 插件的 `library.mcp` / `library.skills`，以及插件页面）。
- 本机安装了 Trae（插件会从 Trae 的 `product.json` 读取客户端信息，用于它自己的登录）。
- 已运行 `magpie plugin login trae-agent` 完成登录。
- Trae 里至少有一个指向 Magpie 网关的现有自定义模型。插件会复用 Trae 已保存的加密密钥；如果还没有，先在 Trae 手动添加一个：
  - Endpoint：`http://127.0.0.1:3425/v1/chat/completions`
  - API Key：Magpie 的 Gateway key
  - Model ID：任意 Magpie 模型

## 安装 / 更新

社区版发布后：

```sh
magpie plugin add @magpie-community/agent-trae
magpie plugin login trae-agent
```

源码目录开发时：

```sh
magpie plugin add .
```

更新时先移除再添加，让 Magpie 重新读取 `package.json`：

```sh
magpie plugin
magpie plugin rm <列表里的名字>
magpie plugin add <路径或包名>
```

仓库：<https://github.com/magpie-community/plugins/tree/main/packages/agent-trae>

## 使用

1. 打开 **Agents** 页，找到 **Trae**，打开连接开关。这一步只写本地连接文件，不会向 Trae 上传任何内容。
2. 点 **模型列表** 那一行的 **「挑选」**，勾选你想在 Trae 里使用的模型（也可以用 `magpie visible trae …`）。
3. 打开插件的 **Trae 模型** 页面：
   - 查看 **将添加 / 将移除 / 保留 / 冲突**；
   - 点 **刷新预览** 重新读取；
   - 点 **镜像到 Trae…**，在确认框中确认后才写入 Trae 云端。
4. 打开或刷新 Trae 的模型页面，选择 `Magpie · …` 模型即可。

### 状态文件

`~/.trae/magpie/model-state.json` 只在确认镜像后写入：

```json
{
  "status": "ok",
  "total": 3,
  "action": "added",
  "added": ["Magpie · <模型名>"],
  "removed": [],
  "rows": ["Magpie · <模型名>"]
}
```

- `status`：`ok` / `working` / `token-required` / `bootstrap-required` / `needs-key` / `unreachable` / `failed`
- `total`：本次镜像的模型数
- `rows`：Trae 里当前由插件管理的模型
- `added` / `removed` / `kept` / `failed`：本轮差异

## MCP 服务器

在 **资源库 → MCP** 里添加服务器并分配给 Trae，插件会把它写入 Trae 的 `User/mcp.json`：

- Windows：`%APPDATA%\Trae\User\mcp.json`
- macOS：`~/Library/Application Support/Trae/User/mcp.json`
- Linux：`~/.config/Trae/User/mcp.json`

规则：

- 只添加/更新/删除插件自己写入的服务器；你自己加的服务器永远保留。
- 同名但非插件写入的服务器不会覆盖，请在日志里看冲突提示。
- 你手动修改过插件写入的服务器后，插件会停止管理它。
- Trae 行断开或插件停用时，插件会撤回自己镜像的条目。

手动操作：

```sh
node bridge.mjs --once          # 同步一次 MCP 并打印摘要
node bridge.mjs --clean         # 只删除插件自己写入的 MCP 条目
node bridge.mjs --preview-models  # 查看模型镜像预览
node bridge.mjs --sync-models --confirm  # 确认并写入模型
```

## 技能

在 **资源库 → 技能** 里把技能分配给 Trae，插件会写入：

```
~/.trae/skills/<skill-name>/SKILL.md
```

这是 Trae 的全局技能目录。若 Trae 没有立即索引，重启 Trae。

## 指令 / Instructions

未启用。Trae 只从每个项目根目录读取 `AGENTS.md`（以及 `.trae/rules/project_rules.md`），没有全局指令文件。需要全局偏好时，可以使用项目根目录的 `AGENTS.md`，或一个 Trae 技能。

## 路径

| 内容 | 路径 |
| --- | --- |
| 连接文件（Magpie 写） | `~/.trae/magpie/connection.json` |
| 模型镜像状态 | `~/.trae/magpie/model-state.json` |
| MCP 暂存文件（Magpie 写） | `~/.trae/magpie/mcp.json` |
| Trae 的 MCP 文件 | `%APPDATA%\Trae\User\mcp.json`（Windows）<br>`~/Library/Application Support/Trae/User/mcp.json`（macOS）<br>`~/.config/Trae/User/mcp.json`（Linux） |
| 技能 | `~/.trae/skills` |

插件自己的其余状态文件也都在 `~/.trae/magpie/` 下。

## 安全边界

- 只写 Magpie 的连接/暂存文件、Trae 的 `User/mcp.json`（只动插件写入的条目）、`~/.trae/skills`，以及在你确认后写 Trae 自己的模型列表。
- 不向 Trae 安装扩展，不使用其他 Magpie 插件的登录，不读取 Trae 的本地凭证或数据库，不启动 Trae，不打开调试端口。
- 模型镜像使用 Magpie 交给这一行的 per-agent key，从不读取 `caller-keys.json` 或网关密钥。
- 模型密钥由 Trae 自己管理；插件只复用 Trae 已保存的加密值，不解密、不保存明文密钥。
- 在 macOS/Linux 上，插件会把包含敏感信息的文件设为 `0600`。

## 排错

| 现象 | 处理 |
| --- | --- |
| 页面提示未登录 / `token-required` | 运行 `magpie plugin login trae-agent`，然后点 **刷新预览**。 |
| `status: bootstrap-required` | Trae 里还没有可复用的 Magpie 自定义模型；按“要求”手动添加一个。 |
| `status: needs-key` | Magpie 的 Gateway key 变了；在 Trae 里更新一次任意 Magpie 模型的 API Key。 |
| `status: unreachable` | 检查网络和 Magpie 网关是否在运行。 |
| `status: failed` | 查看 `error`；Trae 的模型接口可能已变化。 |
| Trae 里没有新模型 | 打开或重启 Trae，或在 **设置 → 模型** 里刷新。 |
| MCP 没出现 | 检查 `~/.trae/magpie/mcp.json` 和 Trae 的 `User/mcp.json`，然后重启 Trae。 |
| 技能没出现 | 确认 `~/.trae/skills/<name>/SKILL.md` 存在，然后重启 Trae。 |

## 开发与测试

```sh
bun test
```

测试覆盖 Agent 描述符、`connect` 输出、MCP 合并与清理、模型预览/确认、多模型集合调和、网关模型列表解析、自己的登录流程。

社区仓库检查：

```sh
bun scripts/check.mjs
```

## 卸载

1. 在 Agents 页断开 Trae。
2. 运行 `magpie plugin` 找到本插件，再运行：

```sh
magpie plugin rm <名字>
```

3. 如需清理 MCP 镜像：

```sh
node bridge.mjs --clean
```

4. Trae 里由插件添加的 `Magpie · …` 模型可以在 Trae 的模型管理里自行删除。
5. 如登录过 `trae-agent`，可用 `magpie plugin logout trae-agent` 清除。

## Trae CN

Trae Global 和 Trae CN 都适用；插件会按本机 Trae 的登录区域连接对应服务。若 `unreachable`，请检查网络和 Trae 版本。

## 许可

MIT。Trae 图标取自本机安装的 Trae 应用，仅用于在 Magpie 中标识该 Agent。
