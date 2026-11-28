# Magpie Kimi Work 原生模型菜单插件

在 Kimi Work 的原生菜单里选择 Magpie 中对 Kimi 可见的模型和路由组。请求经过 Magpie 网关，沿用网关的路由、脱敏、Token 统计和费用记录。

这是面向 **Windows x64** 的开发预览。插件随包提供 KimiWork + 后台组件。安装和接入完成后，保持 Magpie 运行，照常从 Kimi 桌面版打开 Work 即可。

## 从 Magpie 插件市场安装

1. 若已有其他 Magpie Kimi 桌面插件，先停用它。若独立安装的 KimiWork + 正在接管 Kimi Work，先退出其后台。
2. 在 Magpie 打开 **插件 → 发现 → 非官方插件 · GitHub**，找到 **Kimi Work 原生模型菜单**，点击「安装」。卡片会标明未审核。
3. 在 **Agents → Kimi** 接入 Magpie，并设置对 Kimi 可见的模型。打开 Kimi Work 后，在原生模型菜单选择模型或路由组。
4. 在 Magpie 的 **Kimi Work 模型** 页面查看同步状态。首次设置时，如果出现 Windows 授权提示，按提示确认。

也可以从公开仓库安装：

```powershell
magpie plugin add github:A11en4z/magpie-kimiwork-plus-public
```

## 使用与停用

- 初次接入时，原生菜单跟随 Magpie 中对 Kimi 可见的模型和路由组。已保存过选模设置的安装会继续使用原设置。原生菜单条目需要模型的上下文窗口信息。
- 接入完成后，内置后台随 Magpie 启动。若希望登录 Windows 后也自动准备好，可开启 Magpie 的登录自启。
- 停用或卸载前，先在插件页切换到「Magpie 固定主模型」，等页面确认目录释放。直接停用时，部分安装可能在 Kimi Work 菜单残留已同步的条目。更多细节见[兼容性与已知限制](COMPATIBILITY.md)。

## 上游来源与许可证

- **Magpie 社区 Kimi 插件**提供 `kimi-desktop` Agent、设置页和请求适配器。本项目以 `bfb0195` 为基线，保留 Magpie 社区贡献者的版权声明与 MIT 许可证。 [上游源码](https://github.com/magpie-community/plugins/tree/bfb019580a6920e3f50856c620a5d69c0ef7407a/packages/kimi-desktop) · [许可证](LICENSE)
- **KimiWork +** 由 `wssz527` 开发，提供 Windows x64 原生目录同步所用的后台。插件随包分发 `v1.1.17`（源码提交 `cfb3c6f`）发布版中的原始 `gateway-daemon.exe`，并附带 MIT 许可证和第三方声明。 [上游发布版](https://github.com/wssz527/kimiwork-plus/releases/tag/v1.1.17) · [组件来源、校验值和声明](vendor/kimiwork-plus/README.md)

[插件技术说明](TECHNICAL.md)
