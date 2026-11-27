# Magpie 的 Maka 插件

在 Magpie 的 Agents 页面切换 Rust 版 Maka 使用的模型。支持 Windows x64（Intel / AMD）和 Apple Silicon Mac。两个平台的原生 Settings 客户端均随包提供。

## 安装与切换

可以从 Magpie 的 Plugins → Discover → Unofficial, on GitHub 安装，或运行：

```sh
magpie plugin add github:ARE404/magpie-maka-rust
```

使用本地包时，把它解压到固定位置，进入含 package.json 的目录后运行：

```sh
magpie plugin add .
```

启动 Maka，在 Magpie 的 **Agents → Maka** 选择模型。Magpie 的 Bun 插件宿主负责同步，无需安装额外服务、Node.js 或 Rust。普通安装默认连接用户主目录下的 `.maka/application/host`（Windows 为 `%USERPROFILE%\.maka\application\host`）。自定义 Host 用户可在 ~/.magpie-maka-rust/bridge.json 设置 root 为实际目录的绝对路径。

模型修改触发同步，Host 暂时离线时每 10 秒重试。状态见 ~/.magpie-maka-rust/status.json。原生客户端使用 Maka Settings 服务保存连接、凭据和默认模型。手动更换的默认模型会被保留。选择 **Default** 后保持 Magpie 和 Maka 运行，等状态变为 restored 或 idle，再移除插件。跨 Host 更换配置前请先完成断开。

如果桌面版以 `--root` 启动（例如单独的 `nightly-host`），用 `maka host status --root <目录>` 确认该 Host 在线，再把 `~/.magpie-maka-rust/bridge.json` 的 `root` 设为同一个绝对路径。不同 Host 各有自己的默认模型和连接，旧 Host 的 `state.json` 只能用于恢复旧 Host。

在 Windows 上，如果启动 Maka 的应用把本地 AppData 重定向到了自己的包目录，还可在同一文件设置 `controlDirectory`，指向该应用实际的 `Maka/runtime-hosts` 绝对路径。插件会用 Maka 的客户端校验登记信息与在线 Host 的身份。

在 macOS 从原 LaunchAgent 版本升级时先卸载 local.magpie.maka-rust-sync 的 launchd 作业并移走同名 plist；保留 ~/.magpie-maka-rust 中的配置及恢复记录。旧 Electron 插件有单独的作业。

## 开发

运行 npm test。设置 MAGPIE_TEST_BIN 和 MAKA_EMPTY_TEST_ROOT 可额外测试一个独立空 Host 上的连接和恢复。在 macOS 上可用 `sh native/build.sh /path/to/maka-rust-checkout` 重新编译客户端。Windows x64 的构建步骤见 [Windows helper 工作流](.github/workflows/windows.yml)。

本插件由社区独立维护。随包的原生客户端及 Maka 图标使用 Apache Maka 的代码和资产，见 licenses/。Windows 客户端适配 Maka 0.3.0，构建版本为 `apache/maka@16e3a7703eccf5f08b62fcb341b7b903f9a3e7e3`。macOS 客户端基于 `apache/maka@fac7df85c7538245f1376d472c7f70affe95b18d` 构建，已验证 Maka `0.3.0-nightly.20261126.21` 的模型切换和恢复。
