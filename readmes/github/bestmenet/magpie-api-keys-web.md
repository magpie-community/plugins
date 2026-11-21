# API Key Manager for Magpie Web

[中文版](#中文)

A sidebar page for self-hosted `magpie web`. Create, reveal, copy, rename, disable, rotate and delete gateway keys. Set per-key model rules, concurrency and multiple usage budgets. The page opens from the existing authenticated Magpie Web window with no second password prompt.

## Install

1. In **Plugins → Discover**, look for **API Key Manager (Web)** under GitHub/community pages. You can also run `magpie plugin add github:bestmenet/magpie-api-keys-web`.
2. On the **Magpie server**, use Node.js 22+ or Bun to run the checked-in [setup.mjs](setup.mjs) together with its [package.json](package.json). Run it as the service user with the same Magpie config and CLI.
   ```sh
   git clone https://github.com/bestmenet/magpie-api-keys-web.git
   cd magpie-api-keys-web
   node setup.mjs
   ```
   If the CLI is outside PATH, set `MAGPIE_BIN` to its absolute path. If Magpie installed the plugin from a local directory, pass that installed directory to `setup.mjs`.
3. Reopen **Plugins → API Keys · Web** in the existing Web management page.

Requires Magpie **0.1.3960 or later**, Bun on the server, and a stable `MAGPIE_WEB_KEY` already configured for `magpie web`. The plugin sends the Web credential only to the local Magpie Web listener, which defaults to the host from `MAGPIE_ADDR` on port `3430`. For a different local HTTP listener set `MAGPIE_KEY_MANAGER_WEB_ADDR` to its local IP and port. Put HTTPS at your reverse proxy when accessing the admin site over a network.

## Permissions

Setup writes a deploy-specific random capability to this plugin's private Magpie options. The signed-in parent window passes it to the plugin over the official page bridge. The plugin service binds to `127.0.0.1:45185`, requires that credential for reads and writes, and only calls Magpie's gateway-key routes. Treat the plugin options as sensitive configuration. Set `MAGPIE_API_KEYS_ROTATE=1` when rerunning setup to rotate the capability. Disable or remove this plugin in Magpie to remove its sidebar entry.

For the native app, use the [Desktop edition](https://github.com/bestmenet/magpie-api-keys-desktop).

## 中文

这是用于 `magpie web` 的 API Key 管理侧栏。支持创建、复制、重命名、停用和轮换密钥，也能设置模型范围、并发和多个用量额度。安装后在运行 Magpie 的服务器执行一次 `node setup.mjs`，之后侧栏从已登录的 Web 管理窗口获取插件访问凭据，无需再输密码。设置和密钥仍由 Magpie 自身管理。
