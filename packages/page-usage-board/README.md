# magpie usage board

A usage dashboard page inside [magpie](https://usemagpie.ai)'s window: a wall of quota cards
with expiry tiers, daily and per-provider usage charts, 24-hour cache-hit and token curves,
optional remote attribution and per-account detail — served by the plugin's own
zero-dependency local service.

Where [`@magpie-community/page-usage`](https://github.com/magpie-community/plugins/tree/main/packages/usage)
is a bridge-only glance at magpie's summary totals, this page is the full board. Where
[`page-usage-tree`](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)
drills provider → account → model, this one puts quotas, costs and quality on one screen.

## What it answers

1. **Which providers were used** — local direct traffic plus traffic that landed on a remote
   magpie, merged under real provider names (daily chart, provider pies).
2. **How much** — calls, tokens, daily trend; the quota wall shows what is left.
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
   `http://127.0.0.1:3455/`. An 8-second `<meta refresh>` is the fallback if the boot script
   is blocked. The service injects its own token into the board HTML (`window.__KEY__`) and
   checks it on `/api/*`; in plugin mode (the magpie host is the outer gate) the token is
   generated, never typed, and never appears in a URL, the repository or the package. A
   standalone deployment with a `PAGE_KEY` always requires it — the first start prints a
   one-time URL with the key in it (generated keys only; env-provided keys stay in the
   environment).

The 8-second `<meta refresh>` is deliberate: an earlier all-script page could be declared dead
by the host after 10 seconds when the bridge handshake raced; the meta fallback still
navigates if `boot.js` never runs, and the window is wide enough for slow bridge handshakes
that `boot.js` resolves first. The board page also sends the bridge `hello` once it is up.

### Why a local service (and its token)

magpie's bridge exposes a small set of reads — the bridge-only `usage` page uses just
`usage:summary`. This board needs quotas, per-provider/per-day totals, a 7×24 heatmap,
recent requests, TTFT and account detail; those are not in that summary. Like
[`page-usage-tree`](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree),
it therefore runs a small local service that reads `usage.jsonl`.

That service is a separate origin on `127.0.0.1`, outside magpie's auth, so it guards
`/api/*` with its own generated token — injected into the HTML, never typed. When magpie web
is remote, the page goes through `magpie.service` and stays under magpie's origin, so
magpie's key remains the outer gate. A standalone Docker instance has no magpie in front;
there the token (or a reverse proxy) is the gate — see `docs/docker.md`.

## Install

Inside magpie (once the package is merged into the community registry):

```sh
magpie plugin add @magpie-community/page-usage-board
```

Standalone, from a checkout:

```sh
node server.mjs
# [magpie-usage] open http://127.0.0.1:3455/
```

Then open the printed URL. On the default loopback bind the token is injected into the page,
so the URL carries no key. If you set `HOST` to a non-loopback address, the first start
instead prints a one-time URL with `?key=` — that log line is the only place the key appears.
The service reads `~/.config/magpie/usage.jsonl`.

Docker (standalone, e.g. on a VPS):

```sh
MAGPIE_CONFIG=/path/to/magpie/config/magpie docker compose up -d --build
```

The compose file publishes only `127.0.0.1:3456`; put Caddy/nginx in front for a public
host. Two supported modes — proxy auth (no app key) or an app key — are in
[`docs/docker.md`](docs/docker.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3455` | Listen port. The lead page hardcodes 3455; change both if you move it. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless you know why. |
| `PAGE_KEY` | generated | Page/API token. Loopback: injected into the page, never in a URL. Non-loopback standalone start: printed once as a `?key=` URL. Set empty **explicitly** (`PAGE_KEY=`) to disable auth. |
| `PAGE_KEY_FILE` | `~/.config/magpie/usage-page-key` | Where a generated token is stored. |
| `ALLOWED_HOSTS` | empty | Comma-separated extra `Host` names, needed behind a reverse proxy or a non-loopback bind. |
| `GATEWAY` | `http://127.0.0.1:3425` | magpie's local gateway API. |
| `MAGPIE_KEY` | empty | Bearer key for the gateway, when the gateway requires one. |
| `USAGE_JSONL` | `~/.config/magpie/usage.jsonl` | magpie's usage log. |
| `DATA_DIR` | `~/.config/magpie/usage-board` | Generated brand icons and state. |
| `EXTRA_DIRS` | empty | Extra plugin roots to scan for brand icons. |
| `REMOTE_PROVIDERS` | `magpie-direct,magpie-cf,remote-magpie,magpie-2` | Provider aliases counted as "remote" in the 24-hour split. |
| `MAGPIE_ADDR` | set by magpie | Present when the service runs under the magpie host (enables the base-port wait on restart). |
| `ATTRIBUTION` | `auto` | `auto` uses the remote magpie from `providers.json`; `local` keeps attribution on this machine's log. |
| `MAGPIE_PROVIDERS` | `~/.config/magpie/providers.json` | Where the remote URL and key are read from. |
| `REMOTE_BASE` / `REMOTE_KEY` | empty | Explicit remote override (both required) instead of `providers.json`. |
| `REMOTE_CALLERS` | `cloud,Magpie` | Caller names kept for the remote charts; other callers still appear in the caller breakdown. |
| `LOGOS` | unset | `LOGOS=0` skips the brand-icon scan (tests, headless boxes). |
| `EXTRA_DIRS` | empty | Extra plugin roots to scan for brand icons (comma-separated). |

## Data and privacy

- Reads this machine's `usage.jsonl` and magpie's local gateway API. The board itself sends
  no telemetry (on proxied public deployments Cloudflare may inject its own analytics beacon).
- At startup the service scans the plugin directories of THIS machine to collect provider
  brand icons (and downloads an icon over https only when a plugin declares an https icon
  URL); results are cached in the data directory and shown on the quota wall.
- **Optional** remote attribution makes read-only requests to the configured remote magpie's
  own `/v1/magpie/usage/requests`, using the provider key already in
  `~/.config/magpie/providers.json`. Rows are filtered to `REMOTE_CALLERS` and aggregated
  locally; no prompts or message bodies are involved. There is no second service and no page
  key. Set `ATTRIBUTION=local` to keep everything on this machine.
- The page and its assets are served from `127.0.0.1`. API routes require the page token
  (query, cookie or `x-dash-key`), and every route checks `Host` to block DNS rebinding.
  Deliberate anonymous exemptions: `GET /api/ping` and `GET /api/health` (liveness
  fingerprints, no data), `/static/*` and `/logos/*` assets (no data), and the board page
  itself in plugin mode on a loopback bind (the token is injected into the served HTML).
  The trust boundary is the local machine: other local users can reach a loopback-bound
  board, and the remote attribution reads every caller's rows on the shared remote magpie
  (filtered for display, disclosed in the Pages table).
- No prompts or message bodies are read — the service aggregates model, provider, tokens,
  cost, timing and error counts.

## Develop

These commands run from a git checkout — the npm package (`npm pack`) ships the
runtime, docs and notices; `deploy.sh` and `test/` live in the checkout.

```sh
node --test          # auth/host/traversal, caller filtering, package metadata
bash deploy.sh local # refresh the runtime plugin copy (RUNTIME_DIR, default ~/.config/magpie/my-usage-page)
bash deploy.sh vps   # optional standalone board: VPS_HOST + VPS_DIR, scp + md5 check
```

- `static/index.html` is the page source; `deploy.sh` injects `window.__BUILD__`.
- Provider brand logos are collected at service startup from the installed
  magpie plugins of the same machine (no build-time logo set is shipped).
- `npm test` / `npm pack` run the same checks; `prepack` refuses to package a stray
  `remote.js` or a page key.
- Remote attribution and the optional standalone board: see
  [`docs/self-hosting.md`](docs/self-hosting.md).

## License

MIT. `static/echarts.min.js` is a custom Apache-2.0 build of Apache ECharts (see `NOTICE`).
Provider logos are collected at runtime from the installed magpie plugins and are the
trademarks of their owners, used only to identify providers (see `NOTICE`).