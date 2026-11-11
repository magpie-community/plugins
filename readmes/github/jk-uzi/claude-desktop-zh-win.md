<img src="assets/logo.png" width="112" alt="Claude 中文插件图标">

# claude-desktop-zh-win

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](https://github.com/jk-uzi/claude-desktop-zh-win)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

一个 **magpie 插件**，让原版 Claude Desktop 的第三方 Gateway 模式加载官方简体中文界面，同时保留原有设置、会话、历史与网关配置。

本项目基于 [polang233/claude-desktop-zh](https://github.com/polang233/claude-desktop-zh) 与 [liwenjinchn/claude-desktop-zh](https://github.com/liwenjinchn/claude-desktop-zh) 的 0.2.x 运行时版本，保留原作者署名与 MIT 许可。非官方项目，与 Anthropic 无关联。

## 本分支的 Windows 适配

- 识别 Claude 4.x 的 `resources/ion-dist.asar` 前端布局（旧版插件只接受外部 `ion-dist` 目录）。
- 首次安装等待 Claude 正常退出，备份并只写入 `allowDevTools: true`，不修改应用包、签名或 `app.asar`。
- 由 magpie 插件宿主启动后台监听；新的 Claude 进程出现时自动注入官方中文目录。
- **独立渲染窗口也会单独注入**：例如“开发者 → Configure Third-Party Inference…”打开的 `app://localhost/setup-desktop-3p` 设置窗口。
- 兼容旧版官方目录的 6 字符消息 ID，按唯一前缀映射到当前 10 字符 ID；当前测试覆盖率约 99.35%，少量新增文案仍显示英文。

注入只在内存中生效，重启 Claude 即恢复英文；插件监听运行时会在下次启动再次注入。

## 环境要求

- Windows 10/11。
- Claude Desktop 已配置为第三方 Gateway 模式（magpie 的 3p / Gateway 模式）。
- [magpie](https://github.com/magpie-hub/magpie) 保持运行，插件宿主可用。
- Node.js **22+** 在 `PATH` 中（插件宿主会用 `node.exe` 执行文件系统操作）。
- 本机存在与当前前端兼容的官方简体中文目录。插件会先尝试从 Claude 的 Chromium 缓存导入；若缓存没有，再尝试官方 URL；均失败时需要手动导入。

官方翻译资源属于 Anthropic，**不随本仓库分发**。本仓库只包含代码和工具。

## 在 magpie 中安装

在 magpie 插件页添加：

```text
github:jk-uzi/claude-desktop-zh-win
```

也可以选择本仓库根目录安装。若之前安装过 `magpie-claude-zh@latest`（npm 0.1.1）或旧 GitHub 版本，请先移除旧条目，只保留一个来源。

安装后：

1. 启用插件，语言选择 **简体中文 (zh-Hans)**。
2. 保持「启动时加载中文 / runtimeAutoLoad」开启。
3. 保持 magpie 运行。
4. 第一次使用时，如果 Claude 正在运行，插件会等待它正常退出；从托盘或“文件 → 退出”完全退出，约 10 秒后再从原入口打开 Claude。插件会完成首次准备并自动注入。

之后每次启动 Claude，插件会自动检测并加载中文；打开第三方推理设置窗口时也会自动处理。

## 语言目录

默认目录：

```text
%LOCALAPPDATA%\claude-desktop-3p-zh\catalogs
```

插件启动时会自动尝试：

1. 从 Claude 正常模式的 Chromium 缓存导入官方中文目录；
2. 从 `claude.ai` 官方地址下载；
3. 使用已经存在的兼容目录。

如果网络被拦截（官方地址返回 403），可以手动导入官方 JSON：

```powershell
node bin/claude-3p-zh.mjs catalog import --locale zh-Hans --kind base --file <zh-Hans-base.json>
node bin/claude-3p-zh.mjs catalog import --locale zh-Hans --kind dynamic --file <zh-Hans-dynamic.json>
```

插件导出运行时会自动检查覆盖率，低于 95% 会拒绝。

## 常用命令

```powershell
node bin/claude-3p-zh.mjs help
node bin/claude-3p-zh.mjs discover
node bin/claude-3p-zh.mjs runtime-setup-status --profile-dir "%LOCALAPPDATA%\Claude-3p"
npm test
```

## 验证范围

已在以下环境实测通过：

- Windows 11，Claude Desktop 4.16336.0.0（内部版本 44.9.3），第三方 Gateway 模式。
- magpie 插件宿主。
- 主窗口中文；`Configure Third-Party Inference…` 独立设置窗口中文。
- 首次准备、注入事件 `Applied`、DevTools 自动关闭。

未验证：其他 Claude 版本、Windows 10、繁体中文、所有设置页面、macOS 端到端、冷缓存在线下载。macOS 代码仅保留上游实现，见 [docs/macos.md](docs/macos.md)。

## 回滚

1. 在 magpie 中停用或移除插件；停止后重启 Claude 即恢复英文（注入只在内存中）。
2. 如需恢复 `allowDevTools`，先完全退出 Claude，再使用插件首次准备生成的 journal：

```powershell
node bin/claude-3p-zh.mjs runtime-setup-restore --profile-dir "%LOCALAPPDATA%\Claude-3p" --file "<journal.json>"
```

journal 位于 `%LOCALAPPDATA%\claude-desktop-3p-zh\original\runtime\setup-state\` 下。若原始 `developer_settings.json` 不存在，恢复操作会删除它。

## 安全边界

- 不修改 `WindowsApps`、`app.asar`、应用签名或系统权限。
- 不修改 Gateway 地址、API Key、账号身份、会话或历史。
- 首次准备只写入 `allowDevTools`，并在写入前再次确认 Claude 已退出、宿主与注册表哈希未变化。
- 调试器只用于向当前页面注入语言目录，完成后关闭。

## 许可

MIT，见 [LICENSE](LICENSE)。原作者与上游署名见 [NOTICE](NOTICE)。