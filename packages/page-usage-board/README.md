# magpie usage board

A usage dashboard page inside [magpie](https://usemagpie.ai)'s window, served by the plugin's
own zero-dependency local service.

**Most of this board repeats magpie's own Usage page** — the allowance cards, the
per-provider and per-model totals and the request list are all there already. Install this
page for the five things Usage does not show:

1. **Remote attribution by caller key** — traffic routed through a remote magpie, split by
   which caller key caused it (opt-in; see *Remote attribution*).
2. **TTFT p50/p90 per provider** — latency quality next to the volume.
3. **A 7×24 heatmap** — when the calls actually happen, by weekday and hour.
4. **Direct-vs-remote split of the last 24 hours** — how much went out through a remote
   magpie versus straight out of this machine.
5. **Expiry tiers on the quota cards** — how soon each allowance lapses, not just how much
   is left. WorkBuddy's daily `tokens (est.)` window is not treated as expiring credits.

Everything else is convenience around those: daily and per-provider charts, 24-hour
cache-hit and token curves, per-account detail for the remote side.

Where [`@magpie-community/page-usage`](https://github.com/magpie-community/plugins/tree/main/packages/usage)
is a bridge-only glance at magpie's summary totals, this page is the full board. Where
[`page-usage-tree`](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)
drills provider → account → model, this one puts quotas, costs and quality on one screen.

## What it answers

1. **Which providers were used** — local direct traffic plus traffic that landed on a remote
   magpie (opt-in), merged under real provider names (daily chart, provider pies).
2. **How much** — calls, tokens, daily trend; the quota wall shows what is left and when it
   lapses.
3. **How good** — TTFT P50/P90, per-account detail and error counts for the remote side.

The two accounting views (KPI ledger vs. provider charts) and the exit-alias rules are
documented in [`docs/data-semantics.md`](docs/data-semantics.md).

## How it works

Two layers, the same shape the community uses for host-part pages:

1. `index.mjs` is an OpenCode v1 plugin loaded by magpie's Bun host. When magpie calls its
   `server()` entry it starts `server.mjs`, a zero-dependency Node 22+/Bun HTTP service on
   `127.0.0.1:3455`.
2. `page/index.html` + `page/boot.js` is the hosted page. It asks the bridge for
   `magpie.service` first: when `magpie web` runs on another machine it proxies the local
   service under magpie's own origin, so **magpie's own key/auth is the outer gate** and the
   page never leaves that origin. A desktop window has no service, so it falls back to
   `http://127.0.0.1:3455/` — the port it read from `magpie.options.get()`, the same value
   the service was started with. An 8-second `<meta refresh>` is the fallback if the boot
   script is blocked.

The 8-second `<meta refresh>` is deliberate: an earlier all-script page could be declared dead
by the host after 10 seconds when the bridge handshake raced; the meta fallback still
navigates if `boot.js` never runs, and the window is wide enough for slow bridge handshakes
that `boot.js` resolves first.

### Why a local service (and its token)

magpie's bridge exposes a small set of reads — the bridge-only `usage` page uses just
`usage:summary`. This board needs quotas, per-provider/per-day totals, a 7×24 heatmap,
recent requests, TTFT and account detail; those are not in that summary. Like
[`page-usage-tree`](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree),
it therefore runs a small local service that reads `usage.jsonl`.

That service is a separate origin on `127.0.0.1`, outside magpie's auth. The gate is the same
model the community [`page-usage-tree`](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)
uses: the board page is served only on a loopback bind **and** a loopback `Host` — any
non-loopback bind answers 403 for the page — and the service injects its token into the
served HTML (`window.__KEY__`), so nobody types it. `/api/*` (except the two anonymous
liveness routes below) checks the same token from the `x-dash-key` request header. There is
no `?key=` query authentication and no token cookie: a key must never reach a URL, where
proxy and browser-history logs would record it.

The token comes from the `PAGE_KEY` environment variable when you set one (for scripts that
call the API); otherwise every start generates a fresh random token that is never written to
disk and never appears in a log line or URL. When `magpie web` is remote, the page goes
through `magpie.service` and stays under magpie's origin, so magpie's key remains the outer
gate.

## Install

Requires Node 22+. Inside magpie (once the package is merged into the community registry):

```sh
magpie plugin add @magpie-community/page-usage-board
```

Standalone, from a checkout or the npm package:

```sh
npm start            # or: node server.mjs
# [magpie-usage] listening on http://127.0.0.1:3455/
```

The board is local-only: the page answers loopback binds and loopback `Host` names, and a
non-loopback bind never serves it (403) — there is no remote-visitor auth channel. Scripts
that want the API set `PAGE_KEY` and send it as the `x-dash-key` request header. The service
reads `~/.config/magpie/usage.jsonl`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3455` | Listen port; `0` = let the OS pick. When the port is held, the service retries for ~8s, then reuses a live instance of the **same build** (recognised anonymously via the build id on `/api/ping`) or fails with a clear error when a different build or a foreign process holds it. It never scans upward. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback: the board page answers loopback binds and loopback `Host` names only, and other local users of this machine can reach a loopback-bound board. |
| `PAGE_KEY` | generated | Optional token for scripts that call the API (sent as the `x-dash-key` header). When unset, every start generates a random token — not persisted, not logged, not in any URL. Set it **empty explicitly** (`PAGE_KEY=`) to serve the API without a token. |
| `ALLOWED_HOSTS` | empty | Comma-separated extra `Host` names the **API** may be reached by (e.g. behind a reverse proxy). The page stays loopback-only regardless. |
| `GATEWAY` | `http://127.0.0.1:3425` | magpie's local gateway API. Resolved in this order: manifest `options.gateway` → `GATEWAY` → `MAGPIE_GATEWAY` → **`MAGPIE_ADDR`** (set by magpie's plugin host; a `0.0.0.0:`/`[::]:` prefix is normalised to loopback) → the `3425` default. |
| `MAGPIE_KEY` | empty | Bearer key for the gateway, when the gateway requires one. |
| `USAGE_JSONL` | `~/.config/magpie/usage.jsonl` | magpie's usage log. |
| `MAGPIE_CONFIG_DIR` | `~/.config/magpie` | Explicit override for magpie's config directory (magpie itself has no such env — this is for tests and unusual layouts). The service resolves the dir the way magpie does: the **host's cwd** when it carries magpie markers (`usage.jsonl` / `plugins.json` / `providers.json` — the plugin host starts the service with the data dir as cwd, which covers portable installs) → `XDG_CONFIG_HOME/magpie` → `~/.config/magpie`. `usage.jsonl`, `plugin-providers.json` and `providers.json` default to files inside it. |
| `MAGPIE_PROVIDERS_FILE` | `<magpie config dir>/plugin-providers.json` | Where brand logos are read from (magpie's own provider registry — see *Brand logos*). |
| `ATTRIBUTION` | `local` | Remote attribution is **opt-in**: the default `local` keeps attribution on this machine's log; `ATTRIBUTION=remote` (or manifest `options.attribution: "remote"`) makes the service query the configured remote magpie — the provider key is sent to that remote magpie. |
| `MAGPIE_PROVIDERS` | `~/.config/magpie/providers.json` | Where the remote URL and key are read from (used only with `ATTRIBUTION=remote`). |
| `REMOTE_BASE` / `REMOTE_KEY` | empty | Explicit remote override (both required) instead of `providers.json`. |
| `REMOTE_CALLERS` | empty | Caller names kept for the remote charts. **No default** — empty means no caller filtering. |
| `REMOTE_PROVIDERS` | `magpie-direct,magpie-cf,remote-magpie` | Provider aliases counted as "remote" in the 24-hour split. The default is exactly magpie's own three route names; override via manifest `options.remoteProviders`. |

## Manifest options

The magpie manifest (`magpie.options` in package.json) carries the same knobs. Options take
precedence over environment variables, and the built-in default applies when neither is set:

| Option | Default | Meaning |
|---|---|---|
| `port` | `3455` | Service port. `magpie.page.service.option: "port"` tells magpie to inject the user's chosen port into `server(input, options)`; `index.mjs` forwards it to `startServer`. |
| `attribution` | `"local"` | Keep `"local"` to hold attribution on this machine (the default — remote is never enabled implicitly). `"remote"` is the explicit opt-in that queries the configured remote magpie and sends the provider key to it. |
| `remoteCallers` | `""` | Caller filter for the remote charts; empty means no filtering. |
| `remoteProviders` | `"magpie-direct,magpie-cf,remote-magpie"` | Provider aliases counted as "remote" in the 24-hour split. |

## Languages

The interface ships in Chinese and English. `?lang=zh` or `?lang=en` forces one; otherwise
the page follows `navigator.language` automatically.

## Brand logos

The quota wall shows provider brand icons. Everything is assembled from files that already
exist on this machine; the board itself never downloads an image:

- `plugin-providers.json` — magpie's provider registry (`MAGPIE_PROVIDERS_FILE` overrides the
  path). Only `data:image/...` URIs are kept (2 MB per icon, 4 MB total).
- `quotas.json` + `icons/` — magpie's own per-account icon cache, read as data URIs.
- Remote providers (the `magpie-direct/*` cards) are not registered locally, so their
  id→icon mapping comes from the remote magpie's `/v1/magpie/usage/requests` `providers[]`
  (and the `icon` names carried by `/v1/magpie/quotas/cards`), only when remote attribution
  is enabled. The icon bytes themselves are read from the local `icons/` cache
  (`file:<name>` entries) — no third-party request is made.
- If a brand still has no icon, the board also consults its own legacy
  `<config>/usage-board/logos/` directory (written by older builds of this plugin), but only
  for provider ids that the current quota cards actually show.

There is no download, no `/logos` route and no plugin-directory scanning, so the board never
contacts a third-party CDN on your behalf. Providers with no icon anywhere fall back to a
colored first-letter block.

## Data and privacy

- Reads this machine's `usage.jsonl` and magpie's local gateway API. The board itself sends
  no telemetry; its Content-Security-Policy allows no third-party host at all.
- **Remote attribution is opt-in and off by default.** Only `ATTRIBUTION=remote` (or manifest
  `options.attribution: "remote"`) enables it: the service then makes read-only requests to
  the configured remote magpie's own `/v1/magpie/usage/requests` (rows plus the `providers[]`
  icon metadata) and, when that remote magpie does not aggregate its account cards into
  `/v1/magpie/quotas`, to `/v1/magpie/quotas/cards` — all with the provider key already
  configured in this machine's `providers.json`, which is sent to that remote magpie and
  nowhere else. Rows are filtered by `REMOTE_CALLERS` (no default filter) and aggregated
  locally; no prompts or message bodies are involved. There is no second service and no
  separate page key.
- The page and its assets are served from `127.0.0.1`. The trust boundary is the local
  machine: other local users can reach a loopback-bound board, and remote attribution reads
  every caller's rows on the shared remote magpie (filtered for display, disclosed in the
  Pages table).
- The anonymous surface is exactly two routes: `GET /api/ping` (an identity fingerprint +
  build id, used to recognise a live instance of the same build) and `GET /api/health`
  (liveness). Every other `/api/*` route requires the token via the `x-dash-key` header,
  every route checks `Host` to block DNS rebinding, and the board page itself is never
  served on a non-loopback bind or a public `Host` name.
- No prompts or message bodies are read — the service aggregates model, provider, tokens,
  cost, timing and error counts.

## Develop

These commands run from a git checkout — the npm package (`npm pack`) ships the runtime,
docs and notices; `test/` stays in the checkout.

```sh
node --test             # auth/host/page gate, caller filtering, package metadata
npm run build:echarts   # rebuild static/echarts.min.js byte-for-byte (verify: git diff --exit-code static/echarts.min.js)
```

- `static/index.html` is the page source; at request time the service injects
  `window.__DATA__`, `window.QLOGOS` (brand logos) and, on a loopback bind, `window.__KEY__`
  into the served HTML.
- `npm test` / `npm pack` run the same checks; `prepack` refuses to package a stray
  `remote.js` or a literal page key.
- Remote attribution defaults to off and must be opted into (see *Configuration*).

## License

MIT. `static/echarts.min.js` is a custom Apache-2.0 build of Apache ECharts, reproducible
byte-for-byte with `npm run build:echarts` (see `NOTICE`). Provider logos are read at
runtime from magpie's local `plugin-providers.json` and `icons/` cache and are the
trademarks of their owners, used only to identify providers (see `NOTICE`).
