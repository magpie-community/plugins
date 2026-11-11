# magpie-agent-toonflow

[English](README.en.md) | 简体中文

> English: A Magpie agent plugin that detects a local Toonflow installation, makes it manageable from Magpie's Agents page, shares Magpie's text models with Toonflow, and syncs Magpie Library MCP resources to Toonflow. Image/video models are **not** imported as Toonflow media providers; use Magpie's `magpie-image` MCP through the Library instead.

[![Version](https://img.shields.io/badge/version-0.1.1-blue)](https://github.com/Emilia06120878/magpie-agent-toonflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

让 **Magpie** 探测并管理本机 **Toonflow**，把 Magpie 已接入的文本模型提供给 Toonflow，并把 Magpie 资源库中勾选的 MCP 服务同步到 Toonflow。Agent 卡片和插件图标均使用 Toonflow 官方 Logo（MIT，见 [assets/TOONFLOW-LICENSE](assets/TOONFLOW-LICENSE)）。

## 功能矩阵

| 能力 | 是否由本插件导入 | 使用方式 |
| --- | --- | --- |
| Magpie 的**文本模型** | ✅ | 连接 Toonflow 后，全部可选文本模型写入 Toonflow 的 `magpie` 自定义供应商；在 Toonflow 的模型选择器中切换。 |
| Magpie 的**图像/视频模型**作为 Toonflow 媒体模型 | ❌ | 本插件不创建 `providers/*.ts` 媒体供应商，不写入 `mediaProviderConfigs`，也不向 Toonflow 的媒体模型列表导入条目。 |
| Magpie 的**生图能力** | ✅（通过 MCP） | 在 Magpie 资源库把 `magpie-image` 勾选给 Toonflow；Toonflow 通过 MCP 工具 `generate_image`、`generate_video`、`generation_result` 调用 Magpie 已配置的图像/视频模型。 |
| Magpie 资源库的**MCP 服务** | ✅ | 在 Magpie 资源页把服务分配给 Toonflow，插件通过桥接文件把勾选结果翻译进 Toonflow 的 `mcpServers`。 |
| 启动/停止 Toonflow | ❌ | 插件不启动或关闭 Toonflow，不安装 PATH shim；Toonflow 由用户自行打开。 |

> **关于生图模型**：`magpie-image` 使用的是 Magpie 的 Image generation 设置与 MCP 工具参数，不是 Toonflow 媒体模型页的原生供应商模型。Toonflow 媒体节点不会因此自动枚举出全部 Magpie 生图模型。模型列表、默认模型、权限与额度由 Magpie 管理。

## 兼容前提

- Magpie 支持 Agent 插件、`agent.library.mcp` 与资源库 MCP 服务分配。
- 本机安装 [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) 桌面版；本项目针对 Toonflow 2.x 的配置结构开发并在 2.0.10 上验证。
- Toonflow 与 Magpie 运行在同一台 Windows 电脑。
- 文本模型经 Magpie 本地网关的 OpenAI-compatible `/v1` 接口提供。
- 生图/视频经 Magpie 资源库的 `magpie-image` MCP 服务提供；需要 Magpie 已配置对应模型。

## 安装

项目以 GitHub topic `magpie-plugin` 出现在 Magpie 的社区插件发现列表中。也可直接用 Magpie CLI 安装：

```bash
magpie plugin add github:Emilia06120878/magpie-agent-toonflow
```

或在本地克隆后安装目录：

```bash
git clone https://github.com/Emilia06120878/magpie-agent-toonflow.git
magpie plugin add ./magpie-agent-toonflow
```

安装后：

1. 在 Magpie 的 **Plugins** 页确认插件已启用；若修改过源码，先 off/on 一次以重载插件宿主。
2. 打开 Toonflow。
3. 在 Magpie 的 **Agents** 页找到 Toonflow 行，打开连接开关。
4. 在 Toonflow 的文本模型选择器中选择 Magpie 提供的模型。
5. 在 Magpie 资源库把需要的 MCP 服务（包括 `magpie-image`）勾选给 Toonflow。

若要从本机移除插件：

```bash
magpie plugin rm github:Emilia06120878/magpie-agent-toonflow
```

Magpie 会在断开 Agent 时还原其写入的文本供应商配置。插件桥接的 MCP 条目可通过资源库取消勾选同步移除；插件不会改动 Toonflow 用户自己添加的 MCP 服务。

## 工作原理

### 文本模型

插件的 `toonflow.agent.mjs` 使用 Magpie 官方的 connect-only Agent 插件契约。连接时，Magpie 把当前可用文本模型写入 Toonflow `settings.json` 的：

```text
settings.customProviders
```

并写入一个 `magpie` 供应商，使用 Magpie 给该 agent 分配的 gateway key 和 `/v1` 地址。模型选择器保留在 Toonflow 内，因此换模型不需要回到 Magpie。断开时 Magpie 的 stash/restore 机制会还原原值。

连接期间，Toonflow 的 `customProviders` 由 Magpie 供应商独占；用户原有的自定义文本供应商在断开后恢复。

### MCP 资源

Toonflow 的 MCP 客户端配置为数组，Magpie 的 `agent.library.mcpFormat` 支持的是对象格式，因此插件使用一个小桥接层：

```text
Magpie 资源库勾选
  → ~/.config/magpie/toonflow-mcp-bridge.json（claude 格式）
  → 插件 main 模块监听文件变化
  → Toonflow settings.json 的 mcpServers[]（数组格式）
```

同步进 Toonflow 的条目统一带 `magpie-toonflow:` 名称前缀。插件只替换或删除这个前缀的条目，用户手动添加的 MCP 服务保持不变。

### 动态探测

Windows 版 Toonflow 的数据目录位于安装目录内，位置可能随安装方式变化。插件依次尝试：

1. `TOONFLOW_DATA_DIR` 环境变量；
2. 桌面快捷方式中的启动器路径；
3. 正在运行的 Toonflow 进程；
4. Windows 卸载注册表项。

找到数据目录后，在 `~/.config/magpie/toonflow-data` 建立一个目录 junction，供 Magpie 的静态 Agent 配置路径使用。junction 只提供稳定访问路径，不复制数据；若该路径已存在且指向别处，插件会拒绝覆盖。

### `magpie-image` 生图路径

```text
Magpie 资源库 → 给 Toonflow 勾选 magpie-image
  → Toonflow MCP 客户端
  → generate_image / generate_video / generation_result
  → Magpie Image generation 设置与已接入模型
```

这条路径不需要、也不会创建 Toonflow 媒体供应商。插件不在 Toonflow 的媒体模型页显示“默认生图模型”之类的占位条目。

## 安全与边界

- 插件只使用 Magpie 按 agent 分配的 gateway key，不读取、复制或展示上游厂商密钥。
- 不启动/停止 Toonflow，不启用 Toonflow 的 MCP 服务端开关，不向系统 PATH 写启动器。
- 不开常驻 HTTP 监听；MCP 桥接使用本地文件监听。
- 文本模型与 MCP 同步都只写 Magpie/Toonflow 的配置目录；媒体模型配置完全不写。
- Windows 目录 junction 只创建在 Magpie 配置目录内，且不会覆盖已有冲突路径。

## 项目结构

```text
package.json                 插件清单、GitHub 元数据、Agent 入口和官方图标
index.mjs                    Bun 插件宿主入口：探测、创建桥接文件、监听 MCP 勾选变化
toonflow.agent.mjs           moejs Agent 描述符与 connect()：仅写文本模型
lib/discovery.mjs            Windows 安装目录/数据目录探测与稳定 junction
lib/mcp-bridge.mjs           Magpie claude 格式 → Toonflow mcpServers[] 翻译
lib/constants.mjs            路径与 JSON 原子写入工具
assets/                      Toonflow 官方 Logo 与许可
test/                        单元测试
tools/doctor.mjs             只读本机诊断
```

## 开发与验证

```bash
npm test
node tools/doctor.mjs
```

`doctor` 只读取本机路径并报告 Toonflow 探测结果、稳定目录、桥接文件和状态文件；不会修改配置。单元测试覆盖 Agent 文本模型写入、MCP 翻译与所有权、动态探测冲突保护。

## 已知限制

- 目前只实现 Windows 的动态探测；其他平台需提供稳定的 `TOONFLOW_DATA_DIR` 或扩展探测逻辑。
- 连接期间 Magpie 文本供应商独占 `customProviders`。
- Toonflow 媒体模型页不会显示 Magpie 生图模型；请使用资源库中的 `magpie-image` MCP。
- MCP 桥接条目依赖 Magpie 资源库勾选状态，插件不会把任意外部 MCP 配置反向导入 Magpie。
- 真实 GUI 中生图/视频任务是否成功，还取决于 Magpie 的 Image generation 设置、模型权限和额度。

## 许可证

代码使用 [MIT](LICENSE)。Toonflow 官方图标来自 `HBAI-Ltd/Toonflow-app`，其许可见 [assets/TOONFLOW-LICENSE](assets/TOONFLOW-LICENSE)。
