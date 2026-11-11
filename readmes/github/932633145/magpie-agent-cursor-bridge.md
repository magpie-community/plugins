# Cursor · Magpie Bridge

让 Cursor 编辑器直接使用 Magpie 中配置的全部模型与路由组。模型菜单返回 Magpie 模型目录，隐藏 Cursor 默认 Auto 入口，保留 Cursor 原有登录。

当前版本全面支持 **Windows (x64)** 与 **Apple Silicon / Intel macOS**。

---

## 特性

- **全平台支持**：针对 Windows 与 macOS 深度适配原生协议桥接核心，开箱即用。
- **动态模型同步**：在 Magpie 中添加、切换或分组的模型，每 15 秒自动热同步至 Cursor 模型列表。
- **无感代理接管**：连接时自动配置 Cursor 代理，断开连接或卸载时完整自动还原 Cursor 原有配置。
- **安全与隐私**：所有 TLS 证书与回环代理均在本机生成，网络流量仅流经本机回环地址（`127.0.0.1`）至 Magpie 网关，不接触任何外部中转服务。

---

### 安装方式

在 Magpie → **Plugins** 添加仓库地址安装：
```text
github:932633145/magpie-agent-cursor-bridge
```

---

## 安装与快速上手

### 前置条件
- 已在本机安装 **Cursor** 与 **Magpie**。
- 已在 Magpie 中添加并配置好至少一个可用模型或路由组。

---

### Windows 系统使用步骤

1. **运行初始化**：
   在插件目录下打开 PowerShell 执行初始化脚本（或直接双击运行 `setup.cmd`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
   *注：首次初始化时会检查并提示信任本机生成的本地根证书（系统标准确认窗口选择“是”即可）。*

2. **在 Magpie 中选择模型**：
   - 打开 Magpie，在 **Agents** 页面找到 **Cursor · Magpie Bridge**。
   - 打开开关，并从下拉列表中挑选您希望在 Cursor 中使用的模型或路由组。

3. **在 Cursor 中刷新模型列表**：
   - 首次开启后，后台桥接需要几十秒启动；等状态变为已连接即可。
   - 打开对话面板，或点一下底部的模型下拉框——Cursor 会重新拉取模型表，Magpie 提供的模型随即出现，点击即可畅快对话。

   > 无需重启 Cursor。模型目录是按请求下发的，只要 Cursor 重新发起一次拉取就会更新；
   > 若列表没变，再点一次模型下拉框即可。重启也只是强制刷新的一种方式。

---

### macOS 系统使用步骤

1. **运行初始化**：
   在终端中运行：
   ```bash
   bash setup.command
   ```
   *根据系统提示完成本地钥匙串证书信任授权。*

2. **在 Magpie 中选择模型**：
   - 在 Magpie → **Agents** 中开启 **Cursor · Magpie Bridge** 并选择模型。
   - 等后台桥接启动完成（几十秒），在 Cursor 中打开对话面板或点一下模型下拉框即可看到 Magpie 的模型；无需重启 Cursor。

---

## 常用管理命令

| 操作 | Windows (PowerShell) | macOS / Linux (Bash) |
| :--- | :--- | :--- |
| **启动/更新服务** | `powershell -ExecutionPolicy Bypass -File setup.ps1` | `bash setup.command` |
| **查看后台运行状态** | `powershell -ExecutionPolicy Bypass -File setup.ps1 status` | `bash setup.command status` |
| **停用并卸载后台服务** | `powershell -ExecutionPolicy Bypass -File setup.ps1 uninstall` | `bash setup.command uninstall` |

- **断开连接**：在 Magpie 的 Agents 页面选择 Disconnect，或在终端执行 `magpie cursor-bridge default`。
- **代理自愈与还原**：当桥接服务退出或在 Magpie 中断开连接时，Cursor 的代理配置会自动恢复为初始状态。

---

## 架构与工作流程

```text
Magpie Agent 插件 → 写入私有连接配置 (connection.json)
                                ↓
                      后台监视器 (Supervisor)
                      ├─ 启停原生桥接引擎 (cursor-magpie-bridge)
                      └─ 自动维护/还原 Cursor 代理设置 (settings.json)
                                ↓
Cursor 编辑器 ──[本地 TLS 回环代理]──> 原生桥接服务 ──[OpenAI 协议兼容]──> 本地 Magpie 网关 ──> 大模型提供商
```

- **配置与数据隔离目录**：
  - Windows: `%USERPROFILE%\.config\magpie-cursor-bridge\`
  - macOS: `~/.config/magpie-cursor-bridge/`
- **运行产物与自启**：
  - Windows: 自启通过当前用户 Startup 目录无窗口后台执行。
  - macOS: 通过 `launchd` 用户 LaunchAgent 守护。

---

## 开源协议

本项目核心遵循 [MIT License](LICENSE)。
部分原生协议核心来源于开源项目 cursor-byok（MIT License）。
