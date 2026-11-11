<img src="https://raw.githubusercontent.com/liwenjinchn/claude-desktop-zh/main/assets/logo.png" width="128" alt="Claude 中文插件图标">

# claude-desktop-zh

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](docs/first-install.md)
[![macOS](https://img.shields.io/badge/platform-macOS-000000)](docs/macos.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

让原版 Claude Desktop 的第三方 Gateway 模式加载官方中文语言资源，保留现有设置、会话和历史。默认简体中文；少量未匹配文字沿用英文。

本仓库由 liwenjinchn 维护 macOS 适配，基于 polang233 的项目，保留原作者署名及 MIT 许可。它是非官方插件，不改变账号身份、订阅权限或模型服务。

## 版本与分发

- 当前源码候选版本：**0.2.2**。修复 Claude 4.29.0 的 `ion-dist.asar` 布局识别及 macOS 菜单权限误判。
- [GitHub Releases](https://github.com/liwenjinchn/claude-desktop-zh/releases) 已有 **v0.2.1**；该历史标签保持不变，尚不含 0.2.2 修复。
- 截至 2026-10-28，[npm 的 `magpie-claude-zh`](https://www.npmjs.com/package/magpie-claude-zh) latest 仍为 **0.1.1**，属于原作者的 Windows 发布。**0.2.2 尚未发布至 npm**；`package.json` 的版本号不代表 registry 已上线。

## 在 magpie 中安装

Windows 与 macOS 的当前源码均可在 magpie 插件页添加：

```text
github:liwenjinchn/claude-desktop-zh
```

也可添加本仓库根目录。升级时先移除同源旧条目，再添加一种来源，保留唯一安装记录。安装后保持插件启用、默认简体和「启动时加载中文」开启，并保持 magpie 运行。

**macOS 首次安装还需要：**

1. Claude 已配置为第三方 Gateway 模式，Node.js 22+ 可用。
2. 正常退出 Claude，在源码或已安装插件目录运行 `runtime-setup`，备份并开启 `allowDevTools`。macOS 当前不会自动完成此步骤。
3. 给 magpie 授予界面控制权限（部分系统名为「辅助功能」，macOS 27.2 为「设备控制和数据访问」），并允许它通过 System Events 操作菜单。
4. 准备兼容的官方语言目录，统一存到 `~/Library/Application Support/claude-desktop-zh/catalogs`。
5. 从原入口打开 Claude，插件自动加载中文。若缺少前置条件，按状态提示处理后重新保存插件设置或重开 Claude 重试。

具体命令见[安装步骤](docs/first-install.md)及 [macOS 说明](docs/macos.md)。Windows 会在 Claude 正常退出后自动完成首次准备，再从原入口打开即可。

## 独立 CLI

从源码使用时，先进入仓库根目录：

```sh
cd /path/to/claude-desktop-zh
node bin/claude-3p-zh.mjs help
```

独立 CLI 不会后台常驻。未来安装经过验收的 npm 包或本地 tarball 后，可使用声明的 `claude-desktop-zh` 命令；当前 npm 0.1.1 不提供本仓库的 macOS 实现。

## 使用与验证范围

「启动时加载中文」在 macOS 控制后台进程监听，在 Windows 控制自动准备和加载。页面刷新后，macOS 需通过工作台「立即加载中文」或 CLI 再次应用。调试器操作仍可能短暂打开 Chrome 的 `chrome://inspect`；允许 Magpie 自动化 Google Chrome 后，插件会尝试关闭本次唯一新增的调试标签并恢复原焦点，保留原有标签。权限不足时仍可加载中文，但页面会保留。正常加载完成后本地调试端口会关闭。

2026-10-28，本机 macOS 27.2、Claude 4.29.0、第三方 Gateway 模式已实测：正常退出后从原入口重新打开，由真实 magpie watcher 自动加载简体中文，Code 主界面显示中文，调试端口关闭。该结果不代表繁体、所有页面、其他版本或首次冷安装均通过。Windows 历史验证范围见[当前状态](https://github.com/liwenjinchn/claude-desktop-zh/blob/main/docs/status.md)。

![Claude 第三方模式的中文设置界面（历史 Windows 截图）](https://raw.githubusercontent.com/liwenjinchn/claude-desktop-zh/main/docs/images/claude-settings-zh.png)

翻译来自官方中文目录；资源保存在用户本机，不随代码发布。插件不修改 `Claude.app`、签名、网关或系统保护。语言加载与更换官方账号版布局是不同功能，当前版本不提供整套官方账号界面替换，见[本机可行性调查](https://github.com/liwenjinchn/claude-desktop-zh/blob/main/docs/layout-feasibility.md)。

[插件设置](docs/magpie.md) · [发布检查](https://github.com/liwenjinchn/claude-desktop-zh/blob/main/docs/release.md) · [反馈问题](https://github.com/liwenjinchn/claude-desktop-zh/issues) · [NOTICE](NOTICE)
