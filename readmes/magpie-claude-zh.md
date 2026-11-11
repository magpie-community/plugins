<img src="https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/assets/logo.png" width="128" alt="Claude 中文插件图标">

# claude-desktop-zh

[![npm](https://img.shields.io/npm/v/magpie-claude-zh)](https://www.npmjs.com/package/magpie-claude-zh)
[![npm 下载量](https://img.shields.io/npm/dt/magpie-claude-zh?label=npm%20downloads)](https://www.npmjs.com/package/magpie-claude-zh)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](https://github.com/polang233/claude-desktop-zh#%E5%AE%89%E8%A3%85)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/polang233/claude-desktop-zh/blob/main/LICENSE)

在 magpie 中安装，让原版 Claude Desktop 的第三方 Gateway 模式使用中文界面，继续使用原来的设置、会话和历史。

默认简体中文。使用时保持 magpie 运行，从原来的 Claude 入口打开即可。

**npm 包：[`magpie-claude-zh`](https://www.npmjs.com/package/magpie-claude-zh)** · [最新发布](https://github.com/polang233/claude-desktop-zh/releases/latest) · [全部版本](https://github.com/polang233/claude-desktop-zh/releases) · [反馈问题](https://github.com/polang233/claude-desktop-zh/issues)

## 安装

准备好 Windows、magpie 和 Node.js 22 或以上版本，Claude 已配置为第三方 Gateway 模式。

1. 在 magpie 的插件页按 npm 包名 **`magpie-claude-zh`** 添加。也可在「发现 → 非官方插件 · GitHub」中搜索 **claude-desktop-zh**。
2. 保持插件启用，使用默认简体中文和「启动时加载中文」选项。
3. 如果 Claude 正在运行，通过 **File → Exit（文件 → 退出）** 正常退出。看到 Windows 的「中文已准备好」通知后，从原来的入口打开 Claude。

首次准备由插件自动完成。已通过文件夹安装过插件的用户，先在 magpie 中移除旧条目，再安装 npm 包，保留一个安装条目。

源码安装见[安装步骤](https://github.com/polang233/claude-desktop-zh/blob/main/docs/first-install.md)。

## 使用

使用时保持 magpie 运行。每次打开 Claude，插件会自动加载中文；过程中可能短暂出现调试窗口和文件选择框，完成后自动收起。

在插件设置页选择语言并保存，下次打开 Claude 时生效。「启动时加载中文」开关控制后续启动是否加载。

![Claude 第三方模式的中文设置界面](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/claude-settings-zh.png)

## 原理

翻译来自 Claude 官方中文语言文件。插件在 Claude 启动后将对应版本的中文资源加载到当前窗口内存，不修改应用安装目录。

首次准备会备份应用设置并开启自动加载所需的开发者工具选项。语言资源保存在本机，Claude 继续使用原来的数据目录；少量未匹配的文字沿用英文。

## 说明

已在 Windows 商店版 Claude 4.23118.1.0 实测运行时加载简体中文。Claude 4.x 的前端使用 `ion-dist.asar`，插件只读加载，不写入 `WindowsApps`。macOS 支持资源检查和手动运行时导出，尚未实现自动启动注入，也不修改签名。

Claude 更新后，请在 magpie 中关闭再启用插件，让它重新生成对应版本的语言资源。

- [安装步骤](https://github.com/polang233/claude-desktop-zh/blob/main/docs/first-install.md)
- [插件设置与常见问题](https://github.com/polang233/claude-desktop-zh/blob/main/docs/magpie.md)
- [macOS 手动运行时说明](https://github.com/polang233/claude-desktop-zh/blob/main/docs/macos.md)
- [开发与验证](https://github.com/polang233/claude-desktop-zh/blob/main/docs/README.md)

项目代码采用 MIT 许可，官方语言资源的权利归其所有者，见 [NOTICE](https://github.com/polang233/claude-desktop-zh/blob/main/NOTICE)。
