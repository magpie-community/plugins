# Stash

一个 magpie 插件，用来收藏 Prompt 和仓库链接。

[English](README.en.md)

![Stash 的 Prompt 列表](docs/images/stash.png)

## 功能

- 分别管理 Prompt 和仓库，记录名称、介绍及正文或链接。
- 搜索收藏，点击卡片查看和编辑，复制正文或仓库链接。
- 导入 JSON，预览后合并，保留已有内容并跳过重复条目。
- 以 JSON 或 Markdown 导出收藏，复制后保存为文件。
- 跟随 magpie 的主题和界面语言，支持中文、英文和窄窗口。

<details>
<summary>查看编辑界面</summary>

![在 Stash 中编辑 Prompt](docs/images/stash-detail.png)

</details>

## 安装

需要支持页面插件的 magpie。

在 magpie 的“插件 → 发现”页找到手动安装输入框，填入：

```text
github:Fermin214/magpie-stash
```

点击安装，然后从导航栏打开 **Stash**。也可以使用命令行：

```sh
magpie plugin add github:Fermin214/magpie-stash
```

或者下载本仓库并解压，在 magpie 中选择包含 `package.json` 的本地文件夹安装。
无需安装依赖或编译。通过本地文件夹安装时，更新原文件夹中的文件，
再重新打开插件页面即可。

## 数据

收藏保存在本机的 magpie 插件选项中，容量上限为 **60 KiB**。

在“导入导出”中复制 JSON 并保存为文件，可保留完整内容和元数据；
Markdown 适合阅读。导出只包含已经保存的内容。

刷新或关闭 magpie 前请先保存。卸载插件会删除收藏，请先导出。

## 开发

页面使用 HTML、CSS 和 JavaScript，没有构建步骤。

```sh
npm test
```

浏览器验收脚本为 `tests/browser.cjs`，需要 Playwright 和 Chrome。
可通过 `CHROME` 指定浏览器路径，通过 `MAGPIE_BRIDGE` 指定其他版本的桥接脚本。
