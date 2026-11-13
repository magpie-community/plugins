# Claude Desktop 中文 · Windows / macOS / Magpie 插件

把 [javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn) 的 Windows 中文补丁包装成**双击即用的 Windows 程序**和可分享的 Magpie 页面插件。为**第三方 API / Gateway 模式**添加简体中文、繁體中文（台灣）与繁體中文（香港）。

> 不是 API 代理，不配置模型，也不读取或上传 API 密钥。它修改本机 Claude Desktop 的本地资源。

## 最简单：Windows 双击选择语言后汉化

从 [Releases](https://github.com/yys9253462-gif/claude-ag-zh/releases) 下载 `ClaudeDesktop-ZH-CN.exe`，双击即可。

- **不需要 Magpie、Node.js、Python 或安装 .NET**；EXE 已内嵌运行时与全部语言资源。
- **启动后先选择语言，再点击“开始汉化”**，不会打开就修改 Claude。
- 自动检测 Claude、备份、安装所选语言并重新打开 Claude。
- 显示安装进度与详细日志；完成前请勿重复启动。
- 界面提供“恢复官方文件”，使用安装前的备份恢复。
- Windows Store 版若需要管理员权限，会显示 UAC；不会默认接管 WindowsApps 所有权，需单独勾选确认。

要求：64 位 Windows 10/11 与 Claude Desktop。EXE 约 160 MB，首次启动需释放内嵌语言包，安装过程通常需要几分钟，请等待状态变为完成。

也可以在本目录运行独立 EXE。开发构建：

```powershell
powershell -ExecutionPolicy Bypass -File .\standalone\publish.ps1
```

产物：`artifacts/standalone/ClaudeDesktop-ZH-CN.exe`。当前 `--self-test` 仅检查内嵌资源与只读调用链，不执行真实安装或恢复，也不会关闭 Claude。

**Windows 当前验证边界：** 0.3.2 已通过构建、26 项测试和只读自检；Claude `5.1231.2.0` 上的真实汉化尚未成功完成。运行中测到的文件占用不能证明先前失败也是占用造成，先前写入失败的底层错误仍需在安装当时采集。

## macOS 便携版（实验版）

下载：[macOS 0.1.0 实验版](https://github.com/yys9253462-gif/claude-ag-zh/releases/tag/macos-v0.1.0)。附件包含 ZIP 与 SHA-256 校验文件。

Mac 包内提供 `.app` 启动入口与 `.command` 备用入口。先选择语言，再明确确认执行；只有确认后才关闭 Claude 并修改资源。提供原应用备份恢复与本机日志，不需要 Magpie。

**需要预先安装 Python 3.10 或更新版本，不是免运行时版本。** 同一脚本包面向 Apple Silicon / Intel；当前仅在 Windows 完成资源、语法与打包校验，尚未在 Mac 上实际验收。启动器没有 Apple 签名或公证。详细说明见 [macos/README.md](macos/README.md)。

构建 ZIP：

```bash
python -I macos/package.py
```

产物：`artifacts/macos/ClaudeDesktop-ZH-CN-macOS-0.1.0.zip`。解压后双击 `ClaudeDesktop-ZH-CN.app`，按提示选择语言并确认；安装期间会关闭 Claude Desktop，包括正在进行的 Code 对话。

## Magpie 插件版

把上游补丁包装成 Magpie 页面插件，提供三种语言选择、本机检测、安装和恢复。

## 功能

- Magpie 内选择三种中文语言，检查 Claude Store/MSIX 版本并启动安装。
- 完整打包固定版本的上游脚本与资源，安装时不从 GitHub 下载代码。
- 安装前使用上游备份机制；可从同一页面恢复官方文件。
- 安装、恢复互斥执行，保留结果与安装器日志，不把脚本退出码说成界面验证。
- 本机服务只监听 `127.0.0.1`，随机口令保护控制接口，校验 Host 与 Origin，只接受固定 JSON 操作。
- 权限不足时可选 UAC 提权；**接管 WindowsApps 所有权默认关闭，需两次明确确认**。
- 支持独立运行，没有 Magpie 也能使用同一控制台。

## 环境要求

- Windows 10/11，安装 Claude Desktop。
- Magpie `>= 0.1.3216`（页面 `service` 与本地插件宿主）。
- Magpie 使用 Windows 本机安装；其插件宿主需支持 Node.js 内置模块。
- 上游补丁主要面向第三方 API 模式。官方账号在线页面的语言由 Claude 自身提供。

**Linux 服务器上的 Magpie 无法直接修改 Windows 电脑的 Claude。** 这种情况下，请把此包的 `serve.mjs` 放到 Windows 上独立运行，或在 Windows 安装 Magpie 后使用本插件。

## 安装到 Magpie

```powershell
magpie plugin add github:yys9253462-gif/claude-ag-zh
```

在 Magpie 侧栏的插件页面打开 **Claude Desktop 中文**。也可从 Releases 下载 `.tgz`，**先解压，再选择含 `package.json` 的目录**，不要直接把 `.tgz` 文件路径作为插件安装。

本机源码安装示例：

```powershell
magpie plugin add F:\github\claude-ag-zh
```

### 独立运行

```powershell
node serve.mjs
```

打开 <http://127.0.0.1:3485>。要求 Node.js 20 或更新版本，无 npm 运行时依赖。

## 使用

1. 保存 Claude 中的工作，选择界面语言。
2. 点击“安装中文补丁”，确认关闭并重启 Claude。
3. 安装结束后在 Claude 左下角 `Language` 中选择中文；部分新版会直接显示中文。
4. 在 Claude 中检查侧边栏、Gateway 设置、会话与模型选择，确认没有白屏或报错。
5. 需要还原时点击“恢复官方文件”。该操作使用上游备份，不是重新下载 Claude。

安装器会关闭 Claude/Cowork 相关进程并尝试重新启动。上游新版 ASAR 布局会修改 `ion-dist.asar`、`app.asar` 和完整性信息，可能使 Authenticode 签名失效，并调整 Cowork 签名校验分支。请在使用前阅读上游说明：`scripts/README.md`。

### Microsoft Store / WindowsApps 权限

先尝试普通安装。只有明确遇到写入权限失败时，才勾选“使用管理员权限执行安装器”，Windows 会显示 UAC。

“接管 WindowsApps 目录所有权”是另一个独立选项，默认关闭。它会将目录所有者从 `TrustedInstaller` 改为 `Administrators`，**恢复补丁不会自动还原所有权**；通常由重装或升级 Claude 恢复。插件不会静默提权或替你确认 UAC。

## 验证状态

- 插件的 15 项 Node 测试覆盖执行器、请求限制、参数固定、任务互斥、日志与清单。
- 上游 26 项 Python 测试及 9 个可独立执行的 PowerShell 测试脚本已在 Windows 通过；需要真实客户端归档的 `Test-AsarRoundTrip.ps1` 未执行。
- 已在隔离 HOME 的 Magpie 0.1.3216 + 干净 Chromium 中联调通过：插件页面握手、服务代理、控制台和 Claude `4.23118.1.0 / Microsoft Store` 检测正常，无脚本或网络错误。
- **尚未点击安装，尚未完成 Claude 中文界面的实机兼容验收。** 上游存在同系列的未解决反馈：[issue #237](https://github.com/javaht/claude-desktop-zh-cn/issues/237)。安装成功不等于中文界面已验证。
- **独立 EXE 已在 Windows + Claude `4.23118.1.0 / Microsoft Store` 上完成真实自动汉化**：日志确认安装完成、Claude 重启和 Cowork 服务恢复。尚未逐项目视验收全部界面。
- 上游存在同系列的未解决反馈：[issue #237](https://github.com/javaht/claude-desktop-zh-cn/issues/237)。安装成功不等于中文界面已验证。
- 每次 Claude 升级后可能需要恢复并重新安装新版补丁；先检查本插件的 `UPSTREAM.lock.json`。

## 开发

```powershell
npm test
npm pack --dry-run
```

目录：

| 路径 | 用途 |
|---|---|
| `index.mjs` | Magpie/OpenCode v1 本机服务入口 |
| `lib/server.mjs` | 回环 HTTP 服务、令牌、Host/Origin 校验与静态文件 |
| `lib/runner.mjs` | 固定参数、任务互斥、暂存和 UAC 执行 |
| `lib/index.html` | 中文控制台 |
| `page/` | Magpie 沙箱入口、握手与 service 跳转 |
| `scripts/`、`resources/` | 固定版本的上游补丁与 MIT 声明 |
| `UPSTREAM.lock.json` | 上游项目、提交和同步范围 |

更新上游时：审查新版本差异与许可证 → 同步 `scripts/`、`resources/` → 保留日志适配 → 更新锁文件 → 运行上游与插件测试 → 在隔离 Claude 环境实际验证，不能仅替换 JSON。

## 开源与分享

MIT；上游版权、修改范围和第三方边界见 [NOTICE.md](NOTICE.md)。可自由使用、修改和分享，需保留许可声明。

**已发布 GitHub 源码，未自动发布 npm。** Releases 提供独立 Windows `.exe` 与 `.tgz` Magpie 插件包；插件包解压后安装含 `package.json` 的目录。不要将 `.sandbox/`、运行日志、用户配置或 Claude 原始闭源安装包发布出去。

本项目不是 Anthropic 官方产品，也不提供对任何 Claude 新版本的兼容保证。出现问题时先使用“恢复官方文件”，并附上插件版本、Claude 版本、安装方式和脱敏后的错误日志。
