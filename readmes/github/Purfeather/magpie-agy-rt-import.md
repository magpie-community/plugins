# AGY 令牌管理 · Magpie 页面插件

在同一个 Magpie 页面准备 AGY-CLI 导入 JSON，并从已保存的 Magpie 账号导出 Refresh Token（RT）。

## 安装

```sh
magpie plugin add github:Purfeather/magpie-agy-rt-import
```

已安装旧版时，可在 **插件 → 已安装** 检查更新，或运行 `magpie plugin update`。也可以先克隆仓库，再从仓库目录运行 `magpie plugin add .`。

## 导入 RT

1. 在 Magpie 侧栏的插件分组打开 **AGY 令牌管理**。
2. 粘贴一个 Antigravity Refresh Token，点击 **复制导入 JSON**。如果窗口限制自动复制，页面会选中 JSON 供手动复制。
3. 打开 **供应商 → Antigravity（本地 agy CLI）→ 从文件导入账号**，粘贴 JSON 后导入。

账号验证和续期由已安装的 `agy-cli` 插件和本机 `agy` 完成。RT 须来自可被 Antigravity OAuth 客户端续期的有效授权。

## 导出 Magpie 账号的 RT

在 Windows 本机打开 Magpie，进入 **导出 Refresh Token → 自动定位 Magpie 账号 → 打开账号选择窗口**。在弹窗按邮箱或 Profile 选择账号，再点击 **复制 RT**。

自动定位使用 Magpie 的配置目录和 AGY 的状态目录。只列出 Magpie 登记、且有独立 `antigravity-oauth-token` 文件的 AGY 账号。直接复用 Windows 凭据管理器的本机登录态不在列表中。通过 Magpie 的「添加另一个 Google 账号」完成浏览器授权也会生成独立文件。

也可从页面手动选择 `accounts` 目录或单个账号目录。Windows 默认位置为 `%USERPROFILE%\.local\state\magpie-agy-bridge\accounts`。设置了 `XDG_STATE_HOME` 时，目录位于其下的 `magpie-agy-bridge/accounts`。

自动导出由本机 PowerShell 窗口在你确认后读取选中的凭据文件，并直接写入系统剪贴板。插件页面服务只收到操作结果。手动导出和导入格式转换均在当前页面处理。

## 兼容性

已知 `@magpie-community/opencode-agy-cli-auth` 从 `0.1.68` 起支持此导入格式。自动定位需要 Windows 本机 Magpie、Bun 插件宿主和 Windows PowerShell。手动导出仍使用页面的目录选择器。

- [Magpie 页面插件文档](https://usemagpie.ai/docs/plugins#pages)
- [AGY-CLI 导入支持](https://github.com/magpie-community/plugins/commit/9907c187b212c55680acae4d46f5d2c868cda5f2)
