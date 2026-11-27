# magpie-agent-remio

Connect **Remio** (Desktop & CLI) to [Magpie](https://usemagpie.ai)'s **Agents** page: pick any Magpie model or routing group for Remio, preserve your existing custom providers, and automatically restore Remio's original settings when you disconnect.

将 **Remio**（桌面端与 CLI）接入 [Magpie](https://usemagpie.ai/zh/) 的 **Agent 页**：在 Magpie 中统一为 Remio 选择模型或路由组，保留你已有的自定义供应商，断开时自动完整还原 Remio 原有配置。

---

## Features / 功能特性

- **Native Magpie Agents page integration**：Adds a `Remio` row on Magpie's Agents page with model and reasoning effort selection (`magpie remio`).
- **Non-destructive SQLite sync**：Maintains an isolated `Magpie` custom provider (`magpie-gateway`) inside Remio's `remiodb`, leaving all user-defined custom providers untouched.
- **Full model catalog sync**：Optionally syncs Magpie's available models into Remio's `custom_models` table so you can switch models inside Remio as well.
- **Clean automatic rollback**：Creates a one-time backup at `~/.remio/magpie-backup.json` before the first write and restores `model_setting`, `custom_provider_id`, and `llm_user_settings_v2` on disconnect.
- **Zero external dependencies**：Runs directly on Magpie's bundled `moejs` and `Bun` runtimes.

---

## Install / 安装

### Via Magpie UI / 在 Magpie 应用中安装

1. Open **Plugins → Discover → Unofficial · GitHub** and search for **Remio** (or `magpie-agent-remio`), then click **Install**.
2. Or go to **Plugins → Add plugin** and enter `github:chen0518nan-prog/magpie-agent-remio`.

### Via CLI / 命令行安装

```bash
magpie plugin add github:chen0518nan-prog/magpie-agent-remio
```

Then pick a model for Remio:

```bash
magpie models remio
magpie remio auto/auto
```

> **Note / 提示**
> - If Remio Desktop is already running and does not pick up the new model immediately, restart Remio or reopen **Preferences → AI Service**（重启 Remio 桌面端或重新打开「设置 → AI 服务」）.
> - Disconnect Remio (`magpie remio default` or toggle it off on the Agents page) **before** uninstalling this plugin so your original Remio configuration is restored cleanly.

---

## Plugin Options / 插件选项

Configure in **Plugins → Installed → Remio → Options** or via CLI:

```bash
magpie plugin options magpie-agent-remio '{"remioDataDir":"","syncCatalog":true}'
```

| Option | Default | Description |
|---|---|---|
| `remioDataDir` | `""` | Optional custom Remio data directory. Leave empty to auto-detect (`~/Library/Application Support/remio` on macOS, `%APPDATA%/remio` on Windows, `~/.config/remio` on Linux). |
| `syncCatalog` | `true` | Sync Magpie's available model catalog into Remio's `Magpie` custom provider (`custom_models`). |

---

## How It Works / 工作原理

1. **`remio.agent.js` (`magpie.agent`, runs in `moejs`)**：Registers `Remio` as an Agent in Magpie and writes/restores `~/.remio/magpie-agent.json`.
2. **`index.mjs` (`main`, runs in Magpie's Bun host)**：Watches `~/.remio/magpie-agent.json` and atomically reconciles it with Remio's active user `remiodb` (encrypting the gateway key with Remio's AES-256-CBC scheme and backing up/restoring previous settings via `~/.remio/magpie-backup.json`).

---

## Development & Testing / 开发与测试

```bash
# Run unit tests
bun test

# Test in an isolated Magpie sandbox
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add . </dev/null
m plugin --json
m remio
```

## License

MIT
