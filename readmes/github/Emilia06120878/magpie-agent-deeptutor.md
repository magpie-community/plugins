[简体中文](README.md) | [English](README.en.md)

# DeepTutor · Magpie Agent

让 DeepTutor 直接使用 Magpie 中配置的全部模型与路由组，并把 Magpie 资源库中勾选的 MCP 服务同步到 DeepTutor。Magpie 的 Agent 页原本不认识 DeepTutor，装上这个插件之后它出现在列表里。
支持 **Windows / macOS / Linux**，目标版本 **DeepTutor ≥ 1.7.0**。

---

## 特性

- **全部模型一次接入**：Magpie 中配置的模型与路由组会一次性写入 DeepTutor，之后在 DeepTutor 自己的模型列表里可直接切换，不必回到 Magpie 重新配置。
- **与 DeepTutor 官方配置一致**：写入的是 DeepTutor 运行时真正读取的 `model_catalog.json`，不改 DeepTutor 源码，也不改它的启动方式。
- **断开即还原**：连接时逐键备份原值，断开或卸载后恢复为写入前的配置，不影响原有的 profile。
- **资源库 MCP 可选**：Magpie 资源页可以把 MCP 服务勾选给 DeepTutor，插件会翻译到 DeepTutor 的 `mcp.json`；用户自己添加的 MCP 服务不会被覆盖。
- **不动其它配置**：模型同步不修改 `embedding`、`search`、`setup.json`；MCP 同步只写 `mcp.json` 的 `servers`。
- **跨平台**：Windows、macOS、Linux 使用同一套配置路径与命令。

---

### 安装方式

一条命令装好：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Emilia06120878/magpie-agent-deeptutor/main/install.sh | sh
```

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/Emilia06120878/magpie-agent-deeptutor/main/install.ps1 | iex"
```

也可以在 Magpie → **Plugins** 中添加仓库地址：

```text
github:Emilia06120878/magpie-agent-deeptutor
```

或用 Magpie CLI：`magpie plugin add github:Emilia06120878/magpie-agent-deeptutor`

---

## 安装与快速上手

### 前置条件

- 本机已安装 **Magpie**，网关在 `127.0.0.1:3425` 正常响应。
- 本机已安装 **DeepTutor 1.7.0 及以上**，`DEEPTUTOR_HOME` 指向它的运行目录。这个变量必须设置在 **Magpie 进程**的环境中：仅在终端导出，或仅由 DeepTutor 自己的启动脚本设置，Magpie 不会继承。Windows 上建议设置为用户级环境变量并重启 Magpie/桌面应用。
- Magpie 中至少已添加一个可用模型或路由组；如需 MCP 工具，还需在资源库中有至少一个 MCP 服务。

### 步骤

1. **运行体检**：`node tools/doctor.mjs`。它会探测 DeepTutor 目录、校验版本与配置，并打印应当设置的 `DEEPTUTOR_HOME`。
2. **安装插件**：运行上面的安装脚本，或执行 `magpie plugin add github:Emilia06120878/magpie-agent-deeptutor`，随后 `magpie ls` 应能列出 DeepTutor。
3. **在 Magpie 中选择模型**：Agents 页面 → **DeepTutor** → 模型。
4. **在 DeepTutor 中切换模型**：打开 DeepTutor 自己的设置，`Magpie` profile 下已列出全部模型，直接切换即可。
5. **勾选 MCP 服务**：Magpie → 资源库 → MCP，把需要的服务分配给 **DeepTutor**；插件会同步进 DeepTutor 的 MCP 注册表。

> DeepTutor 在对话开始时解析模型路由，新开一个对话即可生效；`deeptutor serve` 长期运行时重启一次更稳妥。MCP 注册表也由 DeepTutor 在启动或设置保存时重载，因此重启服务是应用 MCP 勾选最可靠的方式。插件不启动也不停止该服务。

---

## 常用管理命令

| 操作 | 命令 |
| :--- | :--- |
| **安装前体检** | `node tools/doctor.mjs` |
| **安装插件** | `curl -fsSL https://raw.githubusercontent.com/Emilia06120878/magpie-agent-deeptutor/main/install.sh \| sh` |
| **不用脚本直接装** | `magpie plugin add github:Emilia06120878/magpie-agent-deeptutor` |
| **查看已检测到的 agent** | `magpie ls` |
| **查看 DeepTutor 接管状态** | `magpie deeptutor` |
| **断开并还原配置** | `magpie deeptutor default` |
| **删除插件** | `magpie plugin rm magpie-agent-deeptutor` |
| **运行单元测试** | `npm test` |

---

## 架构与工作流程

```text
Magpie Agent 页
    │  选中模型
    ▼
Magpie Agent 插件 deeptutor.agent.mjs
    │  接收 gateway 与模型列表
    ▼
写入三个键路径
    $DEEPTUTOR_HOME/data/user/settings/model_catalog.json
      services.llm.profiles[]          ← Magpie 提供的全部模型
      services.llm.active_profile_id   ← llm-profile-magpie
      services.llm.active_model_id     ← Magpie 中选中的那个
    │
    ▼
DeepTutor 对话开始
    │  active_profile_id → profile → active_model_id
    ▼
本地 Magpie 网关 http://127.0.0.1:3425
    ▼
模型提供商
```

### MCP 资源库

Magpie 没有 DeepTutor 格式的原生 `mcpFormat`，因此插件使用与 Toonflow 插件相同的桥接思路：

```text
Magpie 资源库勾选
  → ~/.config/magpie/deeptutor-mcp-bridge.json（claude / mcpServers）
  → index.mjs 监听桥接文件并翻译
  → $DEEPTUTOR_HOME/data/user/settings/mcp.json（DeepTutor / servers）
```

同步条目统一使用 `magpie-deeptutor-` 前缀。插件只替换或删除该前缀的条目，用户手动添加的服务以及 DeepTutor 自己管理的超时、工具白名单等字段都会保留。HTTP 翻译为 `streamableHttp`，SSE 保持 `sse`，命令服务翻译为 `stdio`；详见 [docs/deeptutor-mcp.md](docs/deeptutor-mcp.md)。

写入后的 `services.llm` 结构（节选）：

```json
{
  "services": {
    "llm": {
      "profiles": [
        {
          "id": "llm-profile-magpie",
          "name": "Magpie",
          "binding": "custom",
          "base_url": "http://127.0.0.1:3425",
          "api_key": "magpie-deeptutor",
          "api_format": "openai_chat",
          "models": [
            { "id": "group/oneday-glm5.3", "model": "group/oneday-glm5.3", "context_window": 128000 },
            { "id": "group/workbuddyqoderlobster-kimi-k3.1-pro", "model": "group/workbuddyqoderlobster-kimi-k3.1-pro", "context_window": 1048576 }
          ]
        }
      ],
      "active_profile_id": "llm-profile-magpie",
      "active_model_id": "group/oneday-glm5.3"
    }
  }
}
```

---

## 注意事项

- 安装前请设置 `DEEPTUTOR_HOME`。未设置时 Magpie 展开模型配置路径会落到磁盘根目录；MCP 桥接会直接拒绝同步，`tools/doctor.mjs` 会提前发现这种情况。
- 版本要求 DeepTutor 1.7.0 及以上。低于该版本时插件会出现在列表中但无法接管，`tools/doctor.mjs` 会说明原因。
- 切换模型后需要新开对话才会生效；`deeptutor serve` 长期运行时重启一次更稳妥。
- DeepTutor 不会自动监视 `mcp.json`。资源库勾选变化后，若 DeepTutor 正在运行，重启 `deeptutor serve` 以刷新 MCP 连接。

---

## 常见问题

### 对话时报 `Invalid port: ':1]'`

这是代理环境变量的问题，与插件无关。`NO_PROXY` 里如果同时写了 `::1` 和 `[::1]`，httpx 会把 `[::1]` 展开成 `all://*[::1]` 并解析失败，DeepTutor 在建立模型连接时就会抛出：

```
httpx.InvalidURL: Invalid port: ':1]'
```

把 `NO_PROXY` 里的 `[::1]` 去掉，只保留 `::1` 即可：

```text
NO_PROXY=10.69.24.25,198.18.0.1,.local,localhost,127.0.0.1,::1
```

### 切换模型后没有生效

DeepTutor 在对话开始时解析模型路由。新开一个对话即可；`deeptutor serve` 长期运行时重启一次更稳妥。

### 接管后模型列表是空的

Magpie 中还没有配置可用模型。先在 Magpie 里添加账号或模型，再重新选择一次。

### 资源库已勾选 MCP，但 DeepTutor 没显示工具

先运行 `node tools/doctor.mjs --json` 查看桥接文件与 `mcp.json` 的条目数，确认 `DEEPTUTOR_HOME` 对 Magpie 进程可见。DeepTutor 不会监视该文件；重启 `deeptutor serve`，或在 DeepTutor 的 MCP 设置页保存一次以触发重载。

---

## 仓库结构

```text
index.mjs                     Bun 插件宿主：创建/监听 MCP 桥接文件并同步
deeptutor.agent.mjs           moejs Agent 描述符与 connect()
lib/constants.mjs             路径、环境变量展开与原子 JSON 写入
lib/mcp-bridge.mjs            claude mcpServers → DeepTutor servers 翻译
package.json                  包信息与 Magpie 插件声明
install.sh / install.ps1      一键安装脚本（macOS/Linux · Windows）
tools/doctor.mjs              安装前检查：目录、版本、模型与 MCP 配置
test/                         Agent、桥接与插件宿主测试
test/fixtures/                示例配置文件
docs/agent-plugin-contract.md Magpie Agent 插件契约
docs/deeptutor-config.md      DeepTutor 的模型配置位置
docs/deeptutor-mcp.md         DeepTutor 的 MCP 注册表与桥接格式
```

---

## 开源协议

本项目遵循 [MIT License](LICENSE)。
