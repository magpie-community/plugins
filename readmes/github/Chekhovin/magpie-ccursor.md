# Magpie CCursor

[English](README.en.md) · **简体中文**

在 **Cursor** 中直接使用 **Magpie** 管理的模型：由 Magpie 统一管理模型供应商、API 密钥与用量统计，在 Cursor 中自由切换模型、对话和运行 Agent 任务。

`magpie-ccursor` 是适配 Magpie 的 CCursor Agent 插件。它在本机运行轻量协议桥（`127.0.0.1:39831`），将 Cursor 的模型请求转发至本地 Magpie 网关，再由 Magpie 调用你配置的供应商。模型费用按你在 Magpie 中接入的供应商计费。

> **兼容性提醒**：本插件适配 Cursor `3.27.x`，更新的版本可能导致插件无法正常工作。

```text
Cursor → 本机 CCursor 协议桥 (127.0.0.1:39831) → Magpie 网关 → 模型供应商
```

## 快速上手

> **安装前准备（重要）：** 在安装 Magpie CCursor 插件前，请先打开 **Cursor 客户端并完成官方账号登录**。若在未登录状态下先行安装了插件，从浏览器完成网页授权后客户端可能仍停留在未登录状态；如已遇到该问题，请按[浏览器授权后 Cursor 仍无法完成登录](#浏览器授权后-cursor-仍无法完成登录)排查处理。

在 Magpie 中安装插件后，插件会自动检查并接入兼容的 Cursor 客户端。日常使用无需克隆仓库、单独安装 Bun 或手动执行 `setup` 命令：

1. 在 Magpie 插件页面添加 `github:Chekhovin/magpie-ccursor`，或通过命令行安装：

   ```sh
   magpie plugin add github:Chekhovin/magpie-ccursor
   ```

2. 打开 **Agent → CCursor**，启用连接并勾选要分配给 Cursor 的模型。若安装后列表中未立即显示 CCursor，请手动刷新一下 Magpie 页面。附加的 **Cursor 中文界面**开关位于 **Agent 页面底部**，默认开启。
3. 打开 Cursor 并在模型选择器中选择模型（若安装或更新插件时 Cursor 正在运行，请先完全退出再重新打开以加载补丁），发送一条消息验证连接：

   > 只回复「连接成功」。

日常使用请注意：

- **保持 Magpie 运行：** 协议桥随 Magpie 插件宿主运行。在 Magpie 中关闭 CCursor 连接会停止本机桥接服务，重新开启即可恢复。
- **模型自动同步：** 已分配的模型会同步到普通 IDE 窗口与 Agents 窗口；在 Magpie 中调整模型后会自动更新，插件升级也会保留已有分配。
- **默认模型与用量统计：** Cursor 的 **Auto** 及未指定模型的新对话使用 Magpie 分配列表中第一个已启用的模型；模型请求通过 CCursor 专属 Agent key 发送，用量单独统计在该 Agent 下。

## 客户端接入与更新

插件由 Magpie 内置的 Bun 运行时直接加载。首次加载时，插件会自动查找本机 Cursor，备份原始文件并安装接入补丁。

- **插件与客户端更新：** 本插件管理的旧补丁会随插件升级自动更新。Cursor 客户端更新后，保持 Magpie 运行即可自动为兼容版本重新备份并安装补丁，完成后完全退出并重新打开 Cursor。
- **兼容性保护：** 补丁仅支持已适配的 Cursor 构建，并非对所有 Cursor 版本通用。若新版 Cursor 接口变化或客户端文件已被外部修改，插件会保留备份并在日志中提示，不会用旧版文件覆盖新客户端。
- **自定义安装路径：** 若 Cursor 安装在非默认位置，可为 Magpie 设置环境变量 `CCURSOR_CURSOR_ROOT`，指向 Cursor 的 `resources/app` 目录。

更多安装路径、写入权限、中断恢复与版本兼容说明，请参阅[接入与恢复指南](docs/setup.md)。

### 已经使用原版 CCursor

请先停止原版 CCursor 服务并关闭其自动启动，避免与本插件争用 `39831` 端口；原版安装文件可以保留。原版客户端补丁不一定兼容当前插件；若日志提示旧补丁不完整或无法安全升级，请先按原版方式恢复客户端文件（或使用干净的 Cursor 安装），再交由本插件自动接入。详见[接入与恢复指南](docs/setup.md)。

## 中文界面开关

Magpie 的 **Agent 页面底部**提供「Cursor 中文界面」开关，默认开启，用于汉化普通 IDE 窗口与 Agents 窗口的侧栏、设置等界面：

- **独立切换与持久化：** 关闭开关会将 `false` 配置持久化保存（跨 Magpie 重启与插件升级保留），仅移除插件附加的界面翻译，不影响模型接入、已分配模型和历史对话。切换后请等待后台接入完成，再完全退出并重新打开 Cursor。
- **汉化适用范围：** 附带翻译仅对通过版本及原始文件哈希校验的 Cursor 构建生效。未匹配的构建会跳过汉化；跳过汉化本身不会关闭模型接入，但客户端补丁仍需与 Cursor 兼容。文件存在外部改动时，插件可能停止接入并保留备份。
- **与语言包和 `restore` 的区别：**
  - VS Code 中文语言包独立管理，关闭此开关不会卸载语言包，基础编辑器界面可能仍显示中文。
  - 关闭此开关仅移除附加汉化并保留模型接入；而执行 `bun cli.ts restore --cursor-closed` 会还原插件首次备份的 `.original` 客户端文件，并暂停自动接入。

若重启 Cursor 后界面未按预期变化，请查看 Magpie 插件日志或运行 `bun cli.ts status` 排查。支持范围与恢复细节请参阅[汉化与恢复说明](docs/localization.md)。

## 常用命令与配置

日常使用无需运行命令行。如需排查问题、前台调试或手动恢复客户端文件，请先安装 [Bun](https://bun.sh)，然后按[接入与恢复指南](docs/setup.md)克隆仓库并安装依赖，在仓库目录中使用 `bun cli.ts`：

| 操作或配置项 | 命令 / 说明 |
| --- | --- |
| 查看桥接与补丁状态 | `bun cli.ts status`（查看桥接服务、客户端补丁与自动接入状态，不显示任何密钥） |
| 前台运行协议桥（调试） | `bun cli.ts start`，按 `Ctrl+C` 停止 |
| 手动重试接入 | 关闭全部 Cursor 窗口后执行 `bun cli.ts setup --cursor-closed`（亦用于在手动 `restore` 后重新开启自动接入） |
| 还原 Cursor 客户端补丁 | 关闭全部 Cursor 窗口后执行 `bun cli.ts restore --cursor-closed`（还原首次备份文件并暂停自动接入） |
| Cursor 附加汉化 | Magpie **Agent 页底部 → Cursor 中文界面**（默认开启，同步至 `~/.magpie-ccursor/plugin-options.json`） |
| 供应商、模型与 Agent key | 在 Magpie 中管理供应商与密钥，在 **Agent → CCursor** 启用连接并分配模型 |
| 本地配置与会话数据目录 | `~/.magpie-ccursor/`（独立存储，不读取或导入 `~/.ccursor`） |
| 连接配置文件 | `~/.magpie-ccursor/connection.json`（由 Magpie 自动写入与还原） |

> **安全提示：** `~/.magpie-ccursor/` 下的连接配置与派生配置包含本地网关密钥。提交问题或分享日志时，请勿上传这些文件或贴出其中的密钥。

## 故障排查与文档

### 浏览器授权后 Cursor 仍无法完成登录

**现象：** 安装本插件前未在 Cursor 客户端登录账号；安装并启用插件后，在 Cursor 中点击登录并在浏览器完成官方授权，但客户端仍卡在登录/等待响应状态。

**原因：** 默认开启 BYOK 路由（`byokMode: 1`）时，路由配置文件 `~/.magpie-ccursor/routes.json`（Windows 为 `%USERPROFILE%\.magpie-ccursor\routes.json`）的 `redirect` 数组中包含 `"REST:/auth/poll"`。该规则会将 Cursor 轮询网页登录结果的请求转发至本机协议桥（`127.0.0.1:39831`），而本地端点仅返回占位登录数据，导致客户端无法拿到浏览器侧的真实授权结果。

**解决步骤（无需重装或重签名 Cursor）：**

1. **保持服务在线：** 保持 Magpie 运行，并确保 **Agent → CCursor** 连接处于开启状态（让本机协议桥保持在线）。
2. **备份路由文件：** 在修改前先备份路由配置文件：
   - macOS / Linux：`~/.magpie-ccursor/routes.json`（例如复制为 `~/.magpie-ccursor/routes.json.bak`）
   - Windows：`%USERPROFILE%\.magpie-ccursor\routes.json`（PowerShell 下为 `$HOME\.magpie-ccursor\routes.json`）
3. **仅移除登录轮询规则：** 用文本编辑器打开 `routes.json`，从 `redirect` 数组中**只删除 `"REST:/auth/poll"` 这一项**并保存：
   - 注意清理多余逗号，确保保存后仍是**合法 JSON**（若 JSON 语法损坏，协议桥可能使用默认路由，导致 `"REST:/auth/poll"` 重新生效）。
   - **不要**删除 `redirect` 中的其他规则（如 `agent.v1.AgentService/*`、`aiserver.v1.*` 等），**不要**修改 `byokMode`（保持 `1`），也请勿在反馈问题时粘贴 `~/.magpie-ccursor/` 下其他文件中的密钥。
4. **重新登录验证：** 保存后路由配置会自动热更新。回到 Cursor 客户端重新点击登录并在浏览器完成授权，检查客户端是否已成功登录（若仍失败，可能存在网络或账号等其他原因）；此操作会保留原有的 BYOK 模型与 Agent 转发规则。

> **注意：** 切换 BYOK 模式会重建 `redirect` 数组并恢复 `"REST:/auth/poll"`；插件升级后若再次遇到网页授权后客户端无响应，也可复查 `routes.json` 的 `redirect` 数组中是否包含该规则。

### 更多文档

- **接入、恢复与常见问题排查：** [docs/setup.md](docs/setup.md)
- **中文界面开关与兼容说明：** [docs/localization.md](docs/localization.md)
- **架构设计与运行边界：** [docs/architecture.md](docs/architecture.md)
- **本地开发与检查流程：** [CONTRIBUTING.md](CONTRIBUTING.md)

遇到问题？欢迎[提交 Issue](https://github.com/Chekhovin/magpie-ccursor/issues)，反馈时请附上环境信息、复现步骤以及脱敏后的日志输出。

## 致谢与许可证

- 协议桥服务与客户端补丁逻辑移植自 [CometixSpace/CCursor](https://github.com/CometixSpace/CCursor)，针对 Magpie Agent 插件机制的改造说明记录在 [NOTICE.md](NOTICE.md)。
- Cursor 界面汉化参考了 [rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese)。
- 本项目遵循 [AGPL-3.0-or-later](LICENSE) 许可证开源。它是社区维护的第三方插件，非 Cursor、Magpie 或 CCursor 官方发布，按“原样”提供，不附带任何明示或暗示的担保。
