<img src="https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/assets/logo.png" width="208" height="208" alt="Claude 中文插件图标">

# claude-desktop-zh

[![npm](https://img.shields.io/npm/v/magpie-claude-zh)](https://www.npmjs.com/package/magpie-claude-zh)
[![npm 下载量](https://img.shields.io/npm/dt/magpie-claude-zh?label=npm%20downloads)](https://www.npmjs.com/package/magpie-claude-zh)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](https://github.com/polang233/claude-desktop-zh#%E5%AE%89%E8%A3%85)
[![代码 MIT](https://img.shields.io/badge/code-MIT-blue)](https://github.com/polang233/claude-desktop-zh/blob/main/LICENSE)

在喜鹊（magpie）里为 Claude Desktop 的第三方 Gateway 模式启用简体或繁体中文。主窗口和「配置第三方推理」窗口都使用 Claude 官方译文；缺少译文或占位符不匹配的条目沿用英文。继续从原入口启动，使用原来的设置、会话和历史。

**npm 包：[`magpie-claude-zh`](https://www.npmjs.com/package/magpie-claude-zh)** · [最新发布](https://github.com/polang233/claude-desktop-zh/releases/latest) · [全部版本](https://github.com/polang233/claude-desktop-zh/releases) · [反馈问题](https://github.com/polang233/claude-desktop-zh/issues)

## 安装

准备好 Windows、magpie 和 Node.js 22 或以上版本，Claude 已配置为第三方 Gateway 模式。

1. 在 magpie 的插件页按 npm 包名 **`magpie-claude-zh`** 添加。也可在「发现 → 非官方插件 · GitHub」中搜索 **claude-desktop-zh**。
2. 保持插件启用，使用默认简体中文和「启动时自动中文」选项。
3. 如果 Claude 正在运行，通过 **File → Exit（文件 → 退出）** 正常退出。看到 Windows 的「中文已准备好」通知后，从原来的入口打开 Claude。

首次准备由插件自动完成。已通过文件夹安装过插件的用户，先在 magpie 中移除旧条目，再安装 npm 包，保留一个安装条目。

源码安装见[安装步骤](https://github.com/polang233/claude-desktop-zh/blob/main/docs/first-install.md)。

## 使用

在插件页选择语言和汉化方式。Windows 商店版使用默认的「启动时加载」；保持喜鹊运行，主窗口启动或第三方推理设置窗口打开后会自动加载中文。加载时会短暂出现调试窗口和文件选择框，完成后自动收起。插件页显示加载进度和结果。

![喜鹊中的 Claude 中文插件设置页](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/magpie-plugin-settings.png)

![Claude 的语言选择窗口，已选中简体中文](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/claude-language-choice.png)

![Claude 第三方模式的中文设置界面](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/claude-settings-zh.png)

在喜鹊的插件信息页也可打开原图：[喜鹊插件设置](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/magpie-plugin-settings.png) · [Claude 语言选择](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/claude-language-choice.png) · [中文设置界面](https://raw.githubusercontent.com/polang233/claude-desktop-zh/main/docs/images/claude-settings-zh.png)

## 插件会改动什么

- **启动时加载（默认，支持商店版）**：语言包缓存在本机，加载到当前窗口内存里，应用安装文件保持原样。首次准备会等待 Claude 正常退出，备份开发者设置并开启自动加载需要的 DevTools 选项。
- **原位应用（兼容的可写 Windows 解包版）**：正常退出 Claude 并确认后，插件备份原文件，修改前端的语言加载与选择代码，写入中文语言资源。可在插件页恢复原始资源。商店版的受保护安装目录不支持此方式。

## 说明

已在 Windows 商店版 Claude 4.23118.1.0、5.11492.5.0 和 6.6395.0.0 实测启动时加载简体中文；其中 6.6395.0.0 还验证了独立推理设置窗口的打开与重开。macOS 支持资源检查和手动运行时导出，尚未实现启动时自动加载。

Claude 更新后，插件会自动检查并重建语言包。准备进度和失败原因可在「资源维护」查看。

- [安装步骤](https://github.com/polang233/claude-desktop-zh/blob/main/docs/first-install.md)
- [插件设置与常见问题](https://github.com/polang233/claude-desktop-zh/blob/main/docs/magpie.md)
- [macOS 手动运行时说明](https://github.com/polang233/claude-desktop-zh/blob/main/docs/macos.md)
- [开发与验证](https://github.com/polang233/claude-desktop-zh/blob/main/docs/README.md)

项目代码采用 MIT 许可；当前吉祥物参考 CrossPet 角色素材改编，采用 CC BY-NC-SA 4.0。官方语言资源的权利归其所有者。来源与许可见 [NOTICE](https://github.com/polang233/claude-desktop-zh/blob/main/NOTICE)。
