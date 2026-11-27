# 项目规则 · Magpie 插件

在 Magpie 中集中管理已有项目的 **AGENTS.md、CLAUDE.md、GEMINI.md** 及其明确引用的 Markdown，直接编辑原文件。

## 功能

- 自动发现 Magpie 已授权的会话项目和 Library 项目，也可添加扫描目录。
- 三栏布局：项目列表、实际文件目录、单文件编辑；有规则的项目优先显示。
- 查看文档引用关系，支持 Markdown 预览、改动对比和未保存提醒。
- 创建规则入口或缺失的内部引用文档，在资源管理器中定位文件。
- 只检查项目根目录的规则入口并跟随引用，不遍历整个项目。

## 安装

在 Magpie 插件管理中从 GitHub 安装 `liangddyy/magpie-project-rules`，或运行：

```powershell
magpie plugin add github:liangddyy/magpie-project-rules
```

依赖由 Magpie 自动安装，无需另开服务。

## 使用

1. 打开插件的「项目规则」页面，选择项目后自动打开首个可读规则文件。
2. 在中栏切换文件，编辑后点击「保存」或按 `Ctrl+S`；「预览」「改动」「关联」按需打开。
3. 缺少项目时，在「设置」中添加扫描父目录，也可忽略不需要的项目。

目前主要支持 **Windows 本地 NTFS 项目**；不自动读取项目外的引用。保存遇到外部修改会提示冲突，不强制覆盖。未保存内容没有持久恢复，请及时保存。

[开发说明](CONTRIBUTING.md) · [MIT 许可证](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
