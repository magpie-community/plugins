# AGY 令牌管理 · Magpie 页面插件

在同一个 Magpie 页面准备 AGY-CLI 导入 JSON，并从自己选择的 Magpie 账号文件导出 Refresh Token（RT）。

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

1. 在页面的 **导出 Refresh Token** 中选择 Magpie AGY 的 `accounts` 目录，或其中一个账号目录。Windows 默认位置为 `%USERPROFILE%\.local\state\magpie-agy-bridge\accounts`，设置了 `XDG_STATE_HOME` 时位于其下的 `magpie-agy-bridge/accounts`。
2. 按目录 ID（Profile）选中账号，点击 **复制 RT**。如果页面选中了令牌，按 Ctrl+C（macOS 为 Command+C）复制。

页面根据你选择的目录列出 AGY 账号文件。点复制时才读取选中账号的 `antigravity-oauth-token`。直接复用本机 Windows 凭据管理器的登录态没有独立账号文件。通过 Magpie 的「添加另一个 Google 账号」完成浏览器授权也会生成独立文件。

转换和导出均在当前页面完成，无插件权限、后端、遥测或令牌持久化。复制内容包含完整 RT，用完请清理剪贴板。

## 兼容性

已知 `@magpie-community/opencode-agy-cli-auth` 从 `0.1.68` 起支持此导入格式。插件采用 Magpie 的静态页面接口，无依赖或构建步骤。

- [Magpie 页面插件文档](https://usemagpie.ai/docs/plugins#pages)
- [AGY-CLI 导入支持](https://github.com/magpie-community/plugins/commit/9907c187b212c55680acae4d46f5d2c868cda5f2)
