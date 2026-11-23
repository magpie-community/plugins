# antigravity-zh · 喜鹊插件

在喜鹊（Magpie）侧栏检查 Antigravity 的社区汉化更新、应用汉化包或还原原版。译文和汉化包由 [Antigravity 中文本地化社区](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) 维护。本插件独立发布，直接从该项目的 GitHub Releases 下载并校验 SHA-256。

![Antigravity 中文插件的设置页：客户端版本匹配时可下载社区汉化包](docs/magpie-workbench.png)

## 安装与使用

1. 从[最新发布](https://github.com/polang233/antigravity-zh/releases/latest)下载 `antigravity-zh` 插件 ZIP，解压到准备长期保留的位置。
2. 在喜鹊的「插件 → 从文件夹添加」中选择解压后含 `package.json` 的文件夹，启用插件。也可以直接选择本仓库的克隆目录。
3. 从侧栏打开「Antigravity 中文」，点「下载最新版」。确认汉化包与客户端版本匹配后，正常退出 Antigravity，点「应用汉化」。下次从原入口启动即可。

「刷新版本」会查询社区最新正式版。GitHub 暂时不可用时，仍可应用匹配的本地缓存。要切回原版，退出客户端并点「还原官方版」，插件会使用同版本的本机备份。「资源维护」可以打开缓存、安装和配置目录。

Windows 已验证。自定义安装位置可在插件选项中设置 `appDir`。本机页面默认使用 `127.0.0.1:33883`，端口可通过 `port` 设置。从旧版升级时，请在喜鹊的插件列表移除旧登记，再添加新目录。已有独立版的缓存和原版备份可继续使用。独立版将汉化包缓存保存在喜鹊配置目录下的 `antigravity-localization/downloads`，并可识别客户端安装目录中已有的同版本原版备份。

## 来源与许可

插件代码采用 [MIT 许可证](LICENSE)。下载、校验、安装和还原模块改编自社区汉化项目，保留原作者和社区的版权声明。汉化包按需从[社区发布页](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization/releases)获取。

图标是 Gemini 娘手持「文 / A」双语对话牌的 Q 版重绘，角色设计来自 ZipZipPipe。图标及截图中的角色形象按署名、非商业用途使用。[原作立绘](https://www.bilibili.com/opus/1233069202138464289)
