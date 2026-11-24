[简体中文](README.md) | [English](README.en.md)

# DeepTutor · Magpie Agent

让 DeepTutor 直接使用 Magpie 中配置的全部模型与路由组，并把 Magpie 资源库中勾选的 MCP 服务同步到 DeepTutor。Magpie 的 Agent 页原本不认识 DeepTutor，装上这个插件之后它出现在列表里。
支持 **Open DeepTutor 桌面端**（macOS / Windows）和 **CLI**（Windows / macOS / Linux），目标版本 **DeepTutor ≥ 1.7.0**。

---

## 特性

- **全部模型一次接入**：Magpie 中配置的模型与路由组会一次性写入 DeepTutor，之后在 DeepTutor 自己的模型列表里可直接切换，不必回到 Magpie 重新配置。
- **与 DeepTutor 官方配置一致**：写入的是 DeepTutor 运行时真正读取的 `model_catalog.json`，不改 DeepTutor 源码，也不改它的启动方式。
- **断开即还原**：连接时逐键备份原值，断开或卸载后恢复为写入前的配置，不影响原有的 profile。
- **资源库 MCP 可选**：Magpie 资源页可以把 MCP 服务勾选给 DeepTutor，插件会翻译到 DeepTutor 的 `mcp.json`；用户自己添加的 MCP 服务不会被覆盖。
- **不动其它配置**：模型同步不修改 `embedding`、`search`、`setup.json`；MCP 同步只写 `mcp.json` 的 `servers`。
- **Open DeepTutor 桌面端**：无需 `DEEPTUTOR_HOME`。插件加载时把 `~/.config/magpie/deeptutor-home` 链到桌面端数据目录（或 CLI 的 `$DEEPTUTOR_HOME`），Magpie 通过该链接检测并写入真实的 `model_catalog.json`，断开还原仍由 Magpie 自己完成。直接安装不写入用户环境变量，也不需要为了探测而重启 Magpie。
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

标准桌面端直接添加即可。自定义 CLI 工作区可在仓库目录使用显式覆盖和只检查模式：

```powershell
# Windows：-Workspace 可省略；只探测、不安装、不写环境变量
.\install.ps1 -Workspace "<workspace>" -CheckOnly
```

```sh
# macOS / Linux：只探测、不安装、不写环境变量
MAGPIE_DEEPTUTOR_HOME="<workspace>" CHECK_ONLY=1 ./install.sh
```

也可以运行 `node tools/doctor.mjs --home "<workspace>"`。已有显式 `DEEPTUTOR_HOME` 始终优先于桌面自动发现。

安装脚本只有选择旧 CLI / 自定义工作区时才会持久化 `DEEPTUTOR_HOME`，并提示重启 Magpie 让 GUI 继承；选择标准桌面工作区时只使用固定链接，不写用户环境变量，也不要求为探测重启。

---

## 安装与快速上手

### 前置条件

- 本机已安装 **Magpie**，网关在 `127.0.0.1:3425` 正常响应。
- 本机已安装 **DeepTutor 1.7.0 及以上**，任选其一：
  - **Open DeepTutor 桌面端**（macOS / Windows）：打开过一次即可，插件自动找到 `~/Library/Application Support/Open DeepTutor/workspace`（Windows：`%LOCALAPPDATA%\Open DeepTutor\workspace`），无需设置环境变量。
  - **CLI 安装**：`DEEPTUTOR_HOME` 指向运行目录，且设置在 **Magpie 进程**的环境中（仅在终端导出不会被 Magpie 继承）。设置了它就优先于桌面端。
- 插件加载时会建立链接 `~/.config/magpie/deeptutor-home` → 上面找到的目录，Magpie 通过它检测并写入 DeepTutor。
- Magpie 中至少已添加一个可用模型或路由组；如需 MCP 工具，还需在资源库中有至少一个 MCP 服务。

### 步骤

1. **运行体检**：`node tools/doctor.mjs`。它会探测 DeepTutor 目录、校验版本与配置，并显示找到的目录与链接状态。
2. **安装插件**：运行上面的安装脚本，或执行 `magpie plugin add github:Emilia06120878/magpie-agent-deeptutor`，随后 `magpie ls` 应能列出 DeepTutor。
3. **在 Magpie 中选择模型**：Agents 页面 → **DeepTutor** → 模型。
4. **在 DeepTutor 中切换模型**：打开 DeepTutor 自己的设置，`Magpie` profile 下已列出全部模型，直接切换即可。
5. **勾选 MCP 服务**：Magpie → 资源库 → MCP，把需要的服务分配给 **DeepTutor**；插件会同步进 DeepTutor 的 MCP 注册表。

> DeepTutor 在对话开始时解析模型路由，新开一个对话即可生效；桌面端请重启 Open DeepTutor，CLI 的 `deeptutor serve` 长期运行时重启一次更稳妥。MCP 注册表也由 DeepTutor 在启动或设置保存时重载。插件不启动也不停止该服务。

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
index.mjs 加载时
    │  找 $DEEPTUTOR_HOME，否则找 Open DeepTutor 数据目录
    ▼
~/.config/magpie/deeptutor-home  →  真实 workspace

Magpie Agent 页
    │  选中模型
    ▼
Magpie Agent 插件 deeptutor.agent.mjs
    │  接收 gateway 与模型列表
    ▼
写入三个键路径（Magpie 顺着链接写到真实文件）
    ~/.config/magpie/deeptutor-home/data/user/settings/model_catalog.json
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
  → <DeepTutor 目录>/data/user/settings/mcp.json（DeepTutor / servers）
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

- 找不到 DeepTutor（未设置 `DEEPTUTOR_HOME`、桌面端也没运行过）时不建链接，Agents 页显示未检测到，不创建或修改 DeepTutor 的配置。已有失效链接会被移除，但不会触碰它原先指向的真实目录。
- 插件只会 unlink 符号链接或 Windows junction 本身，绝不递归删除目标；若 `~/.config/magpie/deeptutor-home` 是真实目录，插件拒绝处理并保持原样。
- 版本要求 DeepTutor 1.7.0 及以上。低于该版本时插件会出现在列表中但无法接管，`tools/doctor.mjs` 会说明原因。
- 切换模型后需要新开对话才会生效；桌面端请重启 Open DeepTutor，CLI 长期运行时重启 `deeptutor serve` 更稳妥。
- DeepTutor 不会自动监视 `mcp.json`。资源库勾选变化后，若 DeepTutor 正在运行，重启桌面端或 `deeptutor serve` 以刷新 MCP 连接。

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

### Magpie 里看不到 DeepTutor

桌面端至少打开过一次（让 `model_catalog.json` 落盘），或给 Magpie 进程设置 `DEEPTUTOR_HOME`。装完后刷新 Agents 页（或等最多约 30 秒）。`node tools/doctor.mjs` 会显示找到的目录和链接状态。

### 切换模型后没有生效

DeepTutor 在对话开始时解析模型路由。新开一个对话即可；桌面端请重启 Open DeepTutor，CLI 长期运行时重启 `deeptutor serve` 更稳妥。

### 接管后模型列表是空的

Magpie 中还没有配置可用模型。先在 Magpie 里添加账号或模型，再重新选择一次。

### 资源库已勾选 MCP，但 DeepTutor 没显示工具

先运行 `node tools/doctor.mjs --json` 查看桥接文件与 `mcp.json` 的条目数，确认找到的 DeepTutor 目录与链接正确。DeepTutor 不会监视该文件；重启 `deeptutor serve`，或在 DeepTutor 的 MCP 设置页保存一次以触发重载。

---

## 仓库结构

```text
index.mjs                     Bun 插件宿主：把 deeptutor-home 链到真实目录，并同步 MCP
deeptutor.agent.mjs           moejs Agent 描述符与 connect()
lib/constants.mjs             配置路径、home 链接与原子 JSON 写入
lib/home-paths.mjs            唯一的跨平台桌面目录与 catalog 路径规则
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
