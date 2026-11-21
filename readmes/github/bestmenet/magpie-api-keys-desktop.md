# API Key Manager for Magpie Desktop

[中文版](#中文)

A gateway-key management page for the native Magpie app. Create, rename, enable, disable, rotate and delete gateway keys, and manage model rules, concurrency and usage budgets. After one-time local setup, the sidebar opens without a password prompt.

## Install

1. In **Plugins → Discover**, look for **API Key Manager (Desktop)** under GitHub/community pages. Alternatively run `magpie plugin add github:bestmenet/magpie-api-keys-desktop`.
2. On the same computer, with Node.js 22+ or Bun, run the checked-in [setup.mjs](setup.mjs) and [package.json](package.json) as the user who runs Magpie.
   ```sh
   git clone https://github.com/bestmenet/magpie-api-keys-desktop.git
   cd magpie-api-keys-desktop
   node setup.mjs
   ```
   Set `MAGPIE_BIN` if necessary. For non-default or portable profiles, set `MAGPIE_API_KEYS_CONFIG_DIR` to the actual configuration directory, and run the matching Magpie CLI with the same profile. If installed from a local folder, pass its absolute path to `setup.mjs`.
3. Reopen Magpie and select **Plugins → API Keys · Desktop**.

Requires Magpie **0.1.3960 or later**, Bun, and a Magpie gateway bound to loopback. The Desktop management API intentionally returns full secrets only when creating or rotating keys. To copy a key already stored before opening the plugin, use Magpie's native Gateway page.

## Permissions

Setup creates a dedicated Magpie gateway key, grants it **local** management permissions, and writes it in `api-key-manager-desktop.json` in the active Magpie configuration directory. That credential stays on the machine. The sidebar uses a separate random capability supplied by the native window's official plugin page bridge. Its service binds only to `127.0.0.1:45186`. Treat the local credential file and plugin options as sensitive. To revoke this setup, remove the integration key named `APIKeyManagerDesktop-…` in the native Gateway page, disable the plugin, then remove its local credential file.

For `magpie web`, use the [Web edition](https://github.com/bestmenet/magpie-api-keys-web).

## 中文

这是用于 Magpie 桌面应用的 API Key 管理侧栏。安装后运行一次 `node setup.mjs`，为插件配置一个仅限本机的管理凭据，之后打开侧栏无需输入密码。完整密钥在创建和轮换时显示，已存在密钥可在 Magpie 自带的「网关」页复制。
