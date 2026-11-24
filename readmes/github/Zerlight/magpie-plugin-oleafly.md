<div align="center">
  <a href="https://github.com/Oleafly/Oleafly">
    <img src="https://raw.githubusercontent.com/Oleafly/Oleafly/69a9c8cb7019312017ad28f6c300be833e416ea5/src-tauri/icons/128x128.png" alt="Oleafly" width="64" height="64" />
  </a>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/connector-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/connector-light.svg" />
    <img src="./assets/connector-light.svg" alt="connected to" width="128" height="64" />
  </picture>
  <a href="https://github.com/yetone/magpie">
    <img src="https://usemagpie.ai/img/icon-256.png" alt="Magpie" width="64" height="64" />
  </a>
</div>

<h1 align="center">Magpie Plugin for Oleafly</h1>

<p align="center">
  Connect <a href="https://github.com/Oleafly/Oleafly">Oleafly</a> to models, routing groups, skills, and MCP servers managed in <a href="https://github.com/yetone/magpie">Magpie</a>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-000000?style=flat-square" alt="Platforms: macOS, Linux, Windows" />
  <a href="https://github.com/yetone/magpie/releases/tag/v0.1.4738"><img src="https://img.shields.io/badge/Magpie-0.1.2242%2B-24292F?style=flat-square" alt="Magpie 0.1.2242+" /></a>
  <a href="https://github.com/Oleafly/Oleafly"><img src="https://img.shields.io/badge/Oleafly-0.4.13-34B44A?style=flat-square" alt="Oleafly 0.4.13" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22+" />
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

---

## Compatibility

- **Platforms:** macOS, Linux, Windows
- **Oleafly:** `0.4.13`
- **Magpie:** `0.1.2242` or newer, verified through [`0.1.4738`](https://github.com/yetone/magpie/releases/tag/v0.1.4738) (latest release as of 24 November 2026)

> [!NOTE]
> The `0.1.2242` minimum comes from MCP Router behavior: earlier versions (such as `0.1.2241`) only expose **Direct** HTTP servers inside the hub when the Router is on. `0.1.2242` is the first release that keeps standalone **Direct** entries alongside the hub ([upstream commit](https://github.com/yetone/magpie/commit/b889ffe813143e4c4b50683db7409f5163b43870)).

## Quick Start

1. **Install the plugin** by adding this folder on Magpie's **Plugins** page, or from your terminal (macOS/Linux shell or Windows PowerShell) inside this repo:

   ```sh
   magpie plugin add "$PWD"
   ```

2. **Pick a model** in Magpie under **Agents → Oleafly** (a single model or a routing group).
3. **Restart Oleafly** if it was already open, then start a new chat. Fresh Oleafly CLI runs (`oleafly` / `oleafly-cli`) pick up the updated default automatically.

> [!NOTE]
> Installing the plugin won't touch your existing chat model until you pick one in Magpie. Switching models later updates the same Magpie provider in place and leaves any separate **Oleafly Tools** model alone.

Oleafly talks to your local Magpie gateway over its configured port using Oleafly's attribution token. If the gateway is down or unreachable, Magpie shows a warning and retries in the background.

## Skills & MCP Servers

Assign skills and MCP servers to **Oleafly** on Magpie's **Library** page.

### Skills

- **Full-folder copies:** The plugin sets skill delivery to **Copy** for Oleafly, copying each complete skill folder (references and assets included) into your active Oleafly data directory.
- **Name collisions:** If a skill with the same name already exists in Oleafly, resolve it in Magpie with **Keep own** or **Use Library**.
- **Project overrides:** Project-level skill toggles in Oleafly still apply.

### MCP Servers

- **MCP Router on:** Oleafly connects to its Magpie hub along with any servers marked **Direct**.
- **MCP Router off:** Oleafly receives each assigned stdio, Streamable HTTP, and plugin tool server individually.
- **Per-tool restrictions:** Oleafly can't enforce per-tool rules on direct servers. If a direct server has tool-level restrictions, Magpie withholds it and flags it. Route that server through the hub instead so Magpie enforces the rules.
- **URLs & auth:** Direct server URLs are stored in Oleafly's config (numeric `version` query parameters are supported). If a URL carries credentials in the query string, move authentication into a header or route the server through Magpie.
- **Local edits:** If you unassign a server after editing it locally in Oleafly, the plugin disables it instead of deleting it so you can review your changes.

> [!TIP]
> If Oleafly's **Assistant MCP** settings panel was already open when you changed assignments, close and reopen the panel to refresh the server list.

## Disconnecting & Cleanup

- **Reset only the model:** Pick **default** for Oleafly on the **Agents** page. Your previous chat model is restored (falling back to Oleafly's built-in default if you deleted that custom provider while connected), while Library skills and MCP servers stay synced.
- **Disable or uninstall:** Turning the plugin off or removing it from **Plugins** restores your previous chat model and cleans up any managed entries you haven't modified.
- **Local edits stay safe:** Instead of silently overwriting your changes, Magpie flags items that need attention and leaves them in place, such as a copied skill you've edited or the Magpie provider if **Oleafly Tools** still uses it.
- **Deferred cleanup:** If Oleafly is saving settings while you disable or remove the plugin, cleanup waits for its config lock to clear.
  - **macOS & Linux:** Cleanup finishes automatically once Oleafly releases the lock, writing any conflicts to `.magpie-oleafly-cleanup.txt` in your active Oleafly data directory.
  - **Windows:** If the lock outlasts Magpie's shutdown, follow `.magpie-oleafly-cleanup.txt` in your active Oleafly data directory. Once Oleafly finishes saving, re-enable the plugin (reinstall it first if you removed it), then disable it again to finish restoring your previous settings.

## How It Works

The plugin runs inside Magpie's Bun host and updates Oleafly's `config.json` under Oleafly's config lock. Magpie's staged MCP config can contain plaintext credentials while staged and is restricted to your user account (`0700` permissions on macOS/Linux, private user ACLs on Windows). Once synced, Oleafly stores model keys and MCP header/environment credentials in its encrypted secret stores.

### Automatic Discovery

Oleafly shows up on Magpie's **Agents** page even when no CLI binary is on `PATH`:

- **macOS:** `/Applications/Oleafly.app`, `~/Applications/Oleafly.app`, CLI on `PATH`, or an existing `config.json`.
- **Linux:** XDG `.desktop` entries, executable Oleafly AppImages in `~/Applications`, CLI on `PATH` (or `~/.local/bin/oleafly`), or an existing `config.json`.
- **Windows:** Standard MSI / per-user installs (`%ProgramFiles%\Oleafly\oleafly.exe`, `%LOCALAPPDATA%\...`), the registered `oleafly` protocol handler, CLI on `PATH`, or an existing `config.json`.

### Files & Directories

| Path | Purpose |
| --- | --- |
| `~/.magpie-oleafly/` *(Windows: `%USERPROFILE%\.magpie-oleafly\`)* | Private staging directory for agent and Library selections |
| `~/.oleafly/` *(Windows: `%USERPROFILE%\.oleafly\`)* | Default Oleafly data directory (override with `OLEAFLY_DATA_DIR`) |
| `<data-dir>/.magpie-oleafly-state.json` | Ownership hashes and previous chat selection for safe edits and rollback |
| `<data-dir>/.magpie-oleafly-cleanup.txt` | Conflict notes or Windows recovery instructions from deferred cleanup, if any |

If you use a separate Oleafly profile, set `OLEAFLY_DATA_DIR` in both Magpie's and Oleafly's environments so both apps point to the same directory.

## Development

Unit tests require Node.js 22+. On Windows, also set `MAGPIE_BUN` to the Bun executable used by Magpie:

```sh
npm test
```

For Windows, Linux, and macOS setup, end-to-end tests, and desktop verification results, see [integration/README.md](integration/README.md).
