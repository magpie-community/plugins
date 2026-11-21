# Antigravity Switch

[English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 Magpie 中管理本机已有的 Antigravity 账号，查看桌面端、`agy` CLI 和 Magpie 网关的登录状态与模型配额。

## 0.2.1 更新

- 修复 macOS 重启后，Magpie 额度刷新可能收不到结果的问题。
- 账号切换中途失败时恢复已更新的配置，并拦截与所选账号不符的凭据。
- `switch --help` 显示帮助，无效切换参数会报错。页面保留最新的刷新结果。

## 功能

- 界面跟随 Magpie 语言，提供中文和英文。
- 切换桌面端和 CLI 账号，并按需同步 Magpie 的首选账号。macOS 上本地 agy 1.5+ 的「仅 CLI」会更新新启动的 CLI 与桌面端共用的钥匙串登录。已打开的 CodexHost 会话需重新连接后读取新账号。
- 区分实际运行账号与已保存、待生效的账号。
- 页面同步 Magpie 的 agy-cli 供应商账号，邮箱旁标明桌面端和 CLI 的当前登录身份。
- 按 GPT / Claude、Gemini 和 Gemini 4 Argon 分组，展示 5h / 7d 窗口；仅在返回独立额度时增加 Gemini 4 Carbon 列。缺失、过期和 0% 明确区分。
- 按接口原名显示 Pro、Ultra、Enterprise 档位。
- 保留接口提供的 Ultra 倍数；未知档位不当作免费套餐。
- 操作前创建并校验本地凭据备份；配置损坏时保留原文件。
- 保留已有钥匙串访问权限，按系统提示完成授权。

## 安装

需要 macOS、Magpie 0.1.2670+，以及已登录的 Antigravity 桌面端或 `agy` CLI。

从 npm 安装：

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.1
```

也可以从 GitHub 安装：

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.1
```

也可以在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中筛选 **Antigravity Switch**。安装后从侧边栏打开同名页面。

## 终端用法

独立 CLI 需要 Node.js 24+：

```sh
npm install --global magpie-antigravity-switch@0.2.1
magpie-agy-switch status
```

在源码目录中也可以使用 `node index.mjs`：

```sh
# 查看账号状态与配额
node index.mjs status

# 切换到推荐账号
node index.mjs switch best

# 切换到指定账号
node index.mjs switch user@example.com

# 仅切换 CLI
node index.mjs switch user@example.com --target=cli

# 整理账号
node index.mjs organize

# 仅显示已识别会员
node index.mjs members-only on
```

## 数据与权限

页面的「刷新」同步 Magpie 的 agy-cli 供应商名单，并通过 Magpie 查询启用账号的套餐与额度。已移除的账号从列表消失，停用账号归入「不可用账号」。额度查询失败时显示原因，并保留同一登录此前仍有效的额度。未返回的窗口显示「未知」，过期读数显示「待刷新」。

套餐标签沿用 Magpie 返回的原名。账号升级后若仍显示旧 Starter 标签，请参见 [Magpie 套餐刷新问题 #5621](https://github.com/yetone/magpie/issues/5621)；本插件不会自行推断或修改订阅档位。

账号凭据和备份保存在本机，不随插件发布。macOS 可能要求访问钥匙串；拒绝授权时操作停止。请只在自己有权使用的账号之间切换。

## License

[MIT](LICENSE)
