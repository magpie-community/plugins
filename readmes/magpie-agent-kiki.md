# Magpie × Kiki

[![npm](https://img.shields.io/npm/v/magpie-agent-kiki)](https://www.npmjs.com/package/magpie-agent-kiki)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

将 [Kiki](https://github.com/X-T-E-R/kiki) 接入 [Magpie](https://github.com/yetone/magpie) 的 agent 管理体系。安装后，Kiki 会出现在 Magpie 的 **Agents** 页面；在 Magpie 中勾选模型并选择默认模型，Kiki 的模型列表会同步这些模型，新会话使用当前默认模型。

[Kiki](https://github.com/X-T-E-R/kiki) 是一款开源多模型 AI agent 工作台，提供桌面 GUI、TUI 与 Web 界面，支持在 Claude、GPT、Gemini、Kimi 等模型之间调度子智能体，并可在本地运行。[Magpie](https://github.com/yetone/magpie) 是本地模型网关与 agent 管理器，用于集中配置和切换各个 harness 所使用的模型。本项目在两者之间提供配置桥接，使 Kiki 能够像其他 agent 一样由 Magpie 管理。

## 功能

- 在 Magpie 的 **Agents** 页面注册 Kiki，并提供模型选择器。
- 读取 Magpie 的 `/v1/models` 模型目录，把 Magpie 中勾选或可见的全部模型写入 Kiki，而不只是当前默认模型。
- 将当前选定的默认模型、网关地址和密钥同步到 Kiki 的用户配置。
- 同步每个模型的上下文长度、最大输出长度、图片输入能力与思考档位。
- 向 Magpie 声明 Kiki 的 Library 位置，使指令、MCP 服务器和 Skills 写入 Kiki 对应目录。
- 取消选择或停用 Kiki 时，自动撤回插件写入的配置并恢复原有默认模型。
- 仅修改带标记的配置块，保留用户已有的 provider、model 与注释。
- 提供可选的 Kiki 侧 SessionStart 钩子，在 Magpie 未运行时完成同步。

## 工作原理

Magpie 的 agent 插件运行在 moejs 沙箱内，仅支持 JSON、YAML 和 env 形式的配置，且无法访问文件系统；Kiki 的 provider 与 model 则保存在 TOML 中。为完成写入，本包由三个协同部分组成：

1. **Magpie agent 插件**（`kiki.agent.js`）：在 Agents 页面提供 Kiki 条目和模型选择，将当前默认模型写入 `~/.kiki/magpie.json`。
2. **Bun 插件宿主入口**（`kiki.host.js`）：由 Magpie 的 Bun 插件宿主加载并常驻运行。它读取交接文件，并请求 Magpie 的 `/v1/models` 获取当前勾选的模型目录，将全部模型写入 Kiki 的 TOML 配置。
3. **可选的 Kiki 插件**（`kimi.plugin.json` 与 `hooks/sync.mjs`）：在 Kiki 会话启动时执行相同的同步，用于 Magpie 未运行的情况。

模型目录由 Magpie 决定：在 Magpie 中勾选哪些模型，Kiki 的模型列表里就会出现哪些模型；当前默认模型指向 `magpie.json` 中选中的那个。

第 2、3 部分共用 `lib/bridge.mjs` 中的同步逻辑和文件锁。

```text
Magpie Agents 页面
        │ 勾选模型、选择默认模型
        ├──────────────────────────────┐
        ▼                              ▼
~/.kiki/magpie.json              Magpie /v1/models
（默认模型与网关信息）            （当前勾选的模型目录）
        │                              │
        ├── Magpie Bun 插件宿主（监听交接文件，定期刷新目录）
        └── Kiki SessionStart 钩子（可选）
        ▼
~/.kiki/config.toml
~/.kiki/credentials/credentials.toml
```

## 安装

### 环境要求

| 组件 | 要求 |
| --- | --- |
| Magpie | 0.1.2229 或更新，需包含 Bun 插件宿主 |
| Kiki | 0.5.0 或更新 |
| Bun | 1.4.x，由 Magpie 自动下载 |
| Node.js | 18 或更新，仅供可选的 Kiki 侧钩子使用 |

Kiki 的配置目录 `~/.kiki` 必须存在。Magpie 也通过该目录判断 Kiki 是否已安装。

### 通过 npm 安装（推荐）

```sh
magpie plugin add magpie-agent-kiki
```

### 通过源码安装

```sh
git clone https://github.com/brick314116-hue/magpie-kiki.git
magpie plugin add ./magpie-kiki
```

也可以在 Magpie 窗口的 **Plugins → Add a plugin** 中选择克隆后的文件夹。

### 插件发现

Magpie 的 Discover 通过 GitHub 的 `magpie-plugin` 标签发现 agent 插件，本仓库已添加该标签。Magpie 的 npm 搜索仅收录 OpenCode / pi 插件，agent 插件不会出现在 npm 搜索结果中，因此建议直接使用 `magpie plugin add` 安装。

### 可选：Kiki 侧插件

Kiki 侧插件用于在 Magpie 未运行时兜底同步，例如：

- 需要在终端中直接启动 Kiki，而 Magpie 没有运行；
- 使用 `magpie kiki <model>` 修改模型后，希望立即启动 Kiki；
- 当前环境中 Magpie 的 Bun 插件宿主无法启动。

在 Kiki 中执行：

```text
/plugins install --trust https://github.com/brick314116-hue/magpie-kiki
/plugins enable magpie-bridge
```

也可以安装本地克隆后的同一文件夹。使用 GUI 时，在安装预览中选择 **允许并安装**，并选择 **全局使用**，否则会话启动钩子不会执行。

`--trust` 与“允许并安装”是 Kiki 对会执行代码的插件所要求的确认。该钩子只读写 `~/.kiki` 下的本机文件，并向本机 `127.0.0.1` 上的 Magpie 网关请求一次模型目录；它不访问外部网络，也不会常驻运行。

## 使用

1. 启动 Magpie，在 **Agents** 页面找到 **Kiki**。
2. 在 Magpie 中勾选要提供给 Kiki 的模型，并在 Kiki 的模型选择器中选定默认模型。
3. 等待约 1 秒（模型列表变化最多约 10 秒），使 Magpie 的 Bun 宿主完成同步；安装了 Kiki 侧插件时，也可直接启动 Kiki。
4. 新开一个 Kiki 会话，会话将使用所选默认模型；其他已勾选模型会出现在 Kiki 的模型列表中，可在会话或子智能体中使用。

切换模型时重复上述步骤即可，已打开的 Kiki 会话不会中途更换模型。

### 撤回

在 Magpie 的 Agents 页面将 Kiki 切换回原有模型，或停用 Kiki 条目。约 1 秒内（或下一次 Kiki 会话启动时），插件会：

- 删除 `config.toml` 与 `credentials.toml` 中的 `magpie-bridge` 标记块；
- 将 `default_model` 恢复为原有值及其注释；
- 删除 `~/.kiki/.magpie-bridge/state.json`。

如果先卸载了插件，标记块会保留。此时需手动删除 `# >>> magpie-bridge >>>` 与 `# <<< magpie-bridge <<<` 之间的内容，恢复 `default_model`，并删除 `~/.kiki/magpie.json` 和 `~/.kiki/.magpie-bridge/`。

## 配置写入

同步完成后，`~/.kiki/config.toml` 末尾会增加一个带标记的配置块，例如：

```toml
# >>> magpie-bridge >>>
# Written from ~/.kiki/magpie.json by the Magpie Bridge Kiki plugin.
# magpie owns these values; edits here last until the next session.
[providers."magpie-kiki"]
type = "openai"
base_url = "http://127.0.0.1:3425/v1"

[models."magpie-kiki/workbuddy/deepseek-v4.1-flash"]
provider = "magpie-kiki"
model = "workbuddy/deepseek-v4.1-flash"
max_context_size = 1000000
max_output_size = 128000
display_name = "DeepSeek-V4.1-Flash · WorkBuddy"
capabilities = ["thinking", "always_thinking", "image_in"]
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."magpie-kiki/qoder-cn/qfmodel"]
provider = "magpie-kiki"
model = "qoder-cn/qfmodel"
max_context_size = 1000000
display_name = "Qwen3.8-Flash · Qoder CN"
capabilities = ["thinking", "always_thinking", "image_in"]
support_efforts = ["low", "medium", "xhigh"]
default_effort = "medium"
# <<< magpie-bridge <<<
```

每个在 Magpie 中勾选的模型都会有这样一个 `[models."magpie-kiki/<模型 id>"]` 表。同时，插件会将 `default_model` 改为当前选中的 `magpie-kiki/<模型 id>`，并在 `~/.kiki/credentials/credentials.toml` 中写入同一 provider 的 `api_key`。

- `capabilities` 与 `support_efforts` 来自 Magpie 对该模型的描述。模型支持思考档位时，Kiki 才能选择档位；支持图片输入时，才能粘贴截图；模型不能关闭思考时，会标记 `always_thinking`。
- `default_effort` 优先取 `high`，其次为 `medium`、`low`；均不存在时取档位列表的最后一项。
- 用户原有的注释、其他 provider / model、`agent_executor_overrides` 等内容不会被重写。
- 标记块中的内容由 Magpie 管理，手动修改会在下一次同步时被覆盖。
- 如果 Kiki 重写了 `config.toml` 并丢失注释，插件会按表名清理旧块后再写入，不会产生重复表。

### Library

插件向 Magpie 声明了 Kiki 的 Library 位置，Magpie 的指令、MCP 服务器和 Skills 会分别写入：

| 内容 | 路径 |
| --- | --- |
| 指令 | `~/.kiki/AGENTS.md` |
| MCP 服务器 | `~/.kiki/mcp.json`（Kimi 格式） |
| Skills | `~/.kiki/skills/` |

## 注意事项

- **Magpie 端为必需组件。** 只安装 Magpie 端即可使用；Kiki 侧插件是可选的兜底方案。
- **自动同步依赖 Magpie 运行。** 同步由 Magpie 的 Bun 插件宿主执行。Magpie 关闭时，Kiki 继续使用上次同步的配置。
- **同步存在约 1 秒延迟。** 宿主每秒检查一次交接文件，选择默认模型后等待约 1 秒再启动 Kiki 最为稳妥。安装 Kiki 侧插件可消除这一窗口。
- **模型列表最多约 10 秒刷新一次。** 在 Magpie 中勾选或取消勾选模型不会改动默认模型，宿主因此按固定间隔重新读取 `/v1/models`。急切时保存一次模型选择或重启 Magpie 可立即触发同步。
- **模型目录不可用时使用缓存。** 网关暂时关闭时，插件沿用上一次成功读取的模型目录；如果从未成功读取过，则只写入 `magpie.json` 中的当前模型。
- **Magpie 关闭时，CLI 修改不会立即生效。** `magpie kiki <model>` 仅写入交接文件，需等 Magpie 下次启动后才写入 `config.toml`。可通过安装 Kiki 侧插件，或运行一次 `magpie plugin list` 触发宿主同步。
- **仅影响新会话。** Kiki 在会话创建或启动时确定模型，已打开的会话不会中途切换。
- **会修改两个配置文件。** `~/.kiki/config.toml` 与 `~/.kiki/credentials/credentials.toml` 中会出现带 `magpie-bridge` 标记的块，请勿手动修改标记块。取消选择会自动撤回。
- **密钥保存在本机。** `credentials.toml` 会保存 Magpie 网关的密钥。脚本会尽量将文件权限限制为仅当前用户可读，但 Windows 上的 `chmod` 可能不生效。请勿将这两个文件提交到 Git。
- **默认思考档位为 `high`。** 模型提供思考档位时，`default_effort` 优先选择 `high`。可在 Kiki 会话中临时切换档位；修改默认值需要调整脚本后重新安装。
- **两侧同时安装不会冲突。** 两份代码共用 `~/.kiki/.magpie-bridge/sync.lock` 和同一套原子写入机制，同时触发时后执行的一方会跳过。
- **仅支持默认 Kiki 主目录。** 若 Magpie 进程可读取 `KIKI_HOME`，脚本也会使用该变量；目前没有为多个 Kiki 实例分别配置的界面。
- **需要 Bun。** Magpie 的插件宿主运行于 Bun 1.4.x。Bun 不可用时宿主不会启动，自动同步不会发生，此时可使用 Kiki 侧插件兜底。
- **Kiki 侧钩子以当前用户权限运行 Node。** 它只读写上述本机文件，并向本机 Magpie 网关请求模型目录，不访问外部网络，也不常驻。Magpie 侧运行在 Magpie 自带的 Bun 宿主中，行为相同。

## 故障排查

- **Kiki 未出现在 Magpie 的 Agents 页面**：确认插件目录包含 `package.json`，且其中同时存在 `"magpie": { "agent": "./kiki.agent.js" }` 与 `"main": "./kiki.host.js"`；确认 `~/.kiki` 目录存在。在 Magpie 的 Plugins 页面查看该插件是否报错。
- **Magpie 中搜索不到该插件**：Discover 通过 GitHub 的 `magpie-plugin` 标签发现 agent 插件，不会将 agent 插件纳入 npm 搜索结果。直接执行 `magpie plugin add magpie-agent-kiki`。
- **Kiki 里只有当前默认模型**：确认安装的是 `magpie-agent-kiki` 0.2.2 或更新版本，Magpie 正在运行，并等待约 10 秒。查看 `~/.kiki/.magpie-bridge/last.log` 中是否出现 `model catalog returned HTTP ...` 或 `could not fetch the model catalog`；如果网关不可用，插件会沿用上一次成功读取的模型目录。
- **选择了模型但 Kiki 未变化**：
  1. 确认 Magpie 正在运行，并等待 1–2 秒；
  2. 查看 `~/.kiki/.magpie-bridge/last.log`；
  3. 在 Magpie 的 Plugins 页面确认插件没有加载错误；
  4. 仍无法同步时，安装 Kiki 侧插件作为兜底。
- **Magpie 的插件宿主未启动**：Magpie 需要 Bun 1.4.x。运行一次 `magpie plugin list` 可触发宿主；若提示 Bun 相关错误，请按提示处理。Kiki 侧插件不依赖 Magpie 的宿主。
- **找不到 `node`**：仅 Kiki 侧可选钩子需要 Node.js。安装 Node.js 18 或更新版本，并确保其位于 Kiki 进程的 `PATH` 中。
- **`config.toml` 中已存在 `magpie-kiki` provider**：插件会将其视为用户自有配置并拒绝覆盖，日志中会记录 `config.toml already has a magpie-kiki provider table; leaving it alone`。请先重命名或删除该表后重试。

## 项目结构

```text
package.json          Magpie 插件清单（npm 与 Magpie 读取）
kiki.agent.js         Magpie agent 描述与 connect 实现
kiki.host.js          Bun 插件宿主入口：监听交接文件并同步
lib/bridge.mjs        两侧共用的同步逻辑
kimi.plugin.json      Kiki 插件清单（可选的 SessionStart 钩子）
hooks/sync.mjs        Kiki 侧钩子入口，调用 lib/bridge.mjs
icon.svg              图标
README.md             项目说明
LICENSE               MIT 许可证
```

## 开发

本项目无需构建，修改后可直接安装。运行语法检查：

```sh
npm run check
```

## 相关链接

- Kiki：[https://github.com/X-T-E-R/kiki](https://github.com/X-T-E-R/kiki)
- Magpie：[https://github.com/yetone/magpie](https://github.com/yetone/magpie)
- 插件仓库：[https://github.com/brick314116-hue/magpie-kiki](https://github.com/brick314116-hue/magpie-kiki)
- npm 包：[https://www.npmjs.com/package/magpie-agent-kiki](https://www.npmjs.com/package/magpie-agent-kiki)
- 问题反馈：[https://github.com/brick314116-hue/magpie-kiki/issues](https://github.com/brick314116-hue/magpie-kiki/issues)

## 许可证

[MIT](LICENSE)
