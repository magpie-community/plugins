<div align="center">

<img src="page/icon.png" width="88" height="88" alt="magpie-page-credentials">

# magpie-page-credentials

### Every account's quota and reset cards. One page.

**View and manage all your subscriptions, coding plans, and API balances in [magpie](https://github.com/yetone/magpie).**<br>
Track 5h / 7d rate-limit windows, live reset countdowns, and 48-hour sparklines,<br>
refresh quotas on demand, and redeem reset cards (Codex & Zhipu GLM Coding Plan) right from the sidebar.

[![License: MIT](https://img.shields.io/badge/license-MIT-111111)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![magpie plugin](https://img.shields.io/badge/magpie-page%20plugin-3b6cf6)](https://github.com/yetone/magpie)

**English** · [简体中文](README.zh-CN.md)

</div>

<br>

## What it does

`magpie-page-credentials` is a sidebar page plugin (`magpie.page`) for [magpie](https://github.com/yetone/magpie). It requires no separate sign-in or token import: it reads the quota snapshots of the accounts and providers you have already configured in magpie — including **Claude Code**, **Codex (ChatGPT)**, **Antigravity**, **GitHub Copilot**, **WorkBuddy**, **Zhipu GLM Coding Plan**, **Kimi**, **Qwen**, and pay-as-you-go API keys — and gives you a dedicated workspace to inspect and manage them.

| Capability | Details |
| --- | --- |
| **Card & List Views** | Switch between **Card View** (multi-window meters + 48h usage sparklines) and **List View** (a single sticky table header, collapsible provider bands, and container-queried responsive columns for side-by-side comparison). Toggle anytime with `V`. |
| **Smart Grouping & Interactive Summary** | Automatically consolidates standalone pay-as-you-go keys into an **API Balance** group while keeping subscriptions and coding plans grouped by provider. Click any top summary card (*Total*, *Usable*, *Exhausted / Held*, *Reset Cards*) to filter matching accounts immediately. |
| **Primary vs. Auxiliary Window Separation** | Recognizes auxiliary tool/add-on allowances (`MCP · Month`, `Extra usage`, `On-demand`, and sub-credit buckets when `Total credits` is present) as secondary (`aside`). An exhausted add-on quota never falsely marks the account's primary models as exhausted. |
| **Pace Tick & Burn-Rate Alert** | Draws an even-pace reference tick on time-bounded windows (5 hours / 7 days). When consumption runs >15% ahead of elapsed window time, the window is flagged as **Fast** (`用得偏快`). |
| **Multi-Provider Reset Cards** | Supports both **Codex rate-limit reset credits** (via magpie gateway `/v1/magpie/quotas/codex-reset`) and **Zhipu GLM Coding Plan window reset vouchers** (matching available `5 hours` / `7 days` vouchers, redeeming them, and refreshing the plan quota). |
| **Native Provider Icons & Theme Sync** | Ships with 190+ native magpie provider icons (full-color SVG/PNG logos, dark/light adaptive monochrome masks, and custom `file:` icons) and matches magpie's native scrollbar and theme tokens. |
| **Live Countdowns & Keyboard Shortcuts** | Per-second reset and recovery countdowns, click-to-copy account identifiers, quick search (`/`), group toggle (`G`), per-account refresh, and refresh-all. |

## Quick start

**1 · Install**

Run from the terminal:

```sh
magpie plugin add github:miyling/magpie-page-credentials
```

Or open magpie, go to **Plugins**, and add `github:miyling/magpie-page-credentials`.

**2 · Open the page**

Once enabled, **Credentials** (`凭据额度` in Chinese) appears under the **Plugins** group in magpie's left sidebar:

- Works in the **desktop app** (macOS, Windows, Linux) and in **`magpie web`** (including Docker and reverse-proxy setups via `magpie.page.service`).
- Automatically pauses background polling when you switch to another tab and refreshes when you return.

**3 · Update & reload**

```sh
magpie plugin update
```

After updating or editing local files, toggle the plugin **off and back on** in magpie's **Plugins** page to restart the plugin host.

## Options

Configure plugin options in magpie's **Plugins** page (stored in `plugins.json`):

| Option | Default | Description |
| --- | --- | --- |
| `port` | `4396` | Local loopback port (`127.0.0.1`) for the plugin's backend service. Change this if port `4396` is in use. |
| `gatewayUrl` | `""` (auto) | magpie gateway address. Defaults to `MAGPIE_ADDR` if set, otherwise `http://127.0.0.1:3425`. |
| `gatewayKey` | `""` (auto) | Full-access gateway key used for Codex reset actions. Auto-discovered from `caller-keys.json` if omitted. |

> **About reset card permissions**:
> - **Codex reset credits**: Because spending a Codex reset credit cannot be undone, magpie's gateway requires an **enabled, unrestricted, non-read-only** gateway key even on loopback. The plugin automatically picks a qualifying key from `caller-keys.json`; if none exists yet, create one under **Gateway → Gateway keys** or set `gatewayKey` in the plugin options.
> - **Zhipu GLM Coding Plan reset vouchers**: The plugin reads the provider's configuration from `providers.json`, queries available `FIVE_HOUR` / `WEEK` reset vouchers for the selected window, redeems the voucher, and triggers a quota refresh on magpie's gateway.

## Architecture & security

magpie renders plugin pages inside a sandboxed `iframe` (`sandbox="allow-scripts"`, `connect-src 'none'`), so the frame itself cannot make direct network calls to magpie's gateway. This plugin splits into two parts:

```text
index.mjs          Bun plugin host entry; manages the local HTTP service lifecycle
lib/
  server.mjs       Local service (127.0.0.1:4396): static dashboard, /api/* routes, Host/Origin & session checks
  gateway.mjs      Talks to magpie's gateway and upstream reset endpoints (Codex / Zhipu GLM / remote nodes)
  session.mjs      Generates a 24-byte random secret per run and writes page/session/<port>.js atomically
page/
  index.html       Sandboxed sidebar entry page; reads the session secret and redirects the frame to the service
  launcher.js      Handles direct loopback redirect on desktop and magpie.page.service proxy on magpie web
app/
  index.html       Dashboard shell (header, summary cards, filter bar, Card/List container, modal)
  model.js         Pure data logic: provider metadata, window grouping, auxiliary windows, pace math, sorting
  app.js           UI rendering & interactions: Card/List views, theme bridge, reset modal, keyboard shortcuts
  style.css        Responsive layout (Container Queries), sticky table header, and magpie-native scrollbars
  icons/           Built-in magpie provider icon set (color SVG/PNG + adaptive monochrome masks)
test/
  model.test.mjs   Unit tests for window grouping, status calculation, and multi-provider reset cards
  server.test.mjs  Integration tests for session auth, DNS-rebinding protection, CORS, and gateway calls
```

**Security boundaries**:

1. **Secrets stay in-process**: Gateway keys (`caller-keys.json`) and provider keys (`providers.json`) are read only inside the plugin backend process and are never included in API responses, DOM state, or logs.
2. **Loopback-only + DNS-rebinding & Origin checks**: The service binds exclusively to `127.0.0.1` and verifies `Host` (`127.0.0.1:<port>` or `localhost:<port>`) and `Origin` (`null` from the sandboxed frame or loopback).
3. **Per-run session secret (`x-cred-session`)**: Because a sandboxed iframe sends `Origin: null`, `/api/*` responds with `Access-Control-Allow-Origin: *`. To prevent arbitrary websites in a browser from calling the local port to read quotas or spend reset cards, the backend generates a random 24-byte `base64url` secret on start (`page/session/<port>.js`, readable only through magpie's per-run page token), hands it to the dashboard via URL fragment, and verifies `x-cred-session` with `crypto.timingSafeEqual` on every request.
4. **Remote cards stay read-only**: Cards synced from another remote magpie instance (e.g. `office/codex`) are clearly labeled and cannot be refreshed or reset from the local page.

## Development

Zero runtime dependencies. Requires Node.js ≥ 20 or Bun:

```sh
# Run unit and integration tests (all mocked, zero network calls)
npm test

# Start standalone preview server and print the local preview URL with session secret
node scripts/dev.mjs 4397 http://127.0.0.1:3425
```

## License

[MIT](LICENSE)
