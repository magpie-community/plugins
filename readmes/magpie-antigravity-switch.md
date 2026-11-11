# Antigravity Switch

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 Magpie 中管理本机已有的 Antigravity 账号，查看桌面端、`agy` CLI 和 Magpie 网关的登录状态与模型配额。

## 功能

- 切换桌面端和 CLI 账号，并按需同步 Magpie 的首选账号。
- 区分实际运行账号与已保存、待生效的账号。
- 统一读取 Magpie 保存的套餐与配额，本地只识别桌面端和 CLI 当前登录账号。
- 按 GPT / Claude、Gemini 和 Gemini 4 Argon 分组，固定展示 5h / 7d 窗口与更新时间；缺失、过期和 0% 明确区分。
- 按接口原名显示 Pro、Ultra、Enterprise 档位，并按会员状态筛选、整理账号。
- 保留接口提供的 Ultra 倍数；未知档位不当作免费套餐。
- 操作前创建并校验本地凭据备份；配置损坏时保留原文件。
- 保留已有钥匙串访问权限，按系统提示完成授权。

## 安装

需要 macOS、Magpie 0.1.2670+，以及已登录的 Antigravity 桌面端或 `agy` CLI。

从 npm 安装：

```sh
magpie plugin add npm:magpie-antigravity-switch@0.1.4
```

也可以从 GitHub 安装：

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.1.4
```

也可以在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中筛选 **Antigravity Switch**。安装后从侧边栏打开同名页面。

## 终端用法

独立 CLI 需要 Node.js 24+：

```sh
npm install --global magpie-antigravity-switch@0.1.4
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

额度来自 Magpie 的本地缓存。页面的「刷新」重新读取该缓存与本地登录状态，不会逐个账号向服务端强制查询；实际更新时间显示在各账号下。未返回的窗口显示「未知」，过期读数显示「待刷新」。

套餐标签沿用 Magpie 返回的原名。账号升级后若仍显示旧 Starter 标签，请参见 [Magpie 套餐刷新问题 #5621](https://github.com/yetone/magpie/issues/5621)；本插件不会自行推断或修改订阅档位。

账号凭据和备份保存在本机，不随插件发布。macOS 可能要求访问钥匙串；拒绝授权时操作停止。请只在自己有权使用的账号之间切换。

## License

[MIT](LICENSE)
