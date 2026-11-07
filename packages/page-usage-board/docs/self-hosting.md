# Remote attribution and self-hosting

The board normally runs on the same machine as magpie. Remote attribution answers one
question: traffic this machine sent through a **remote** magpie landed on which real provider
account, and how fast was it?

The local service gets that from the remote magpie's own usage API — the URL and key are
already in this machine's `~/.config/magpie/providers.json`:

```
GET https://<remote>/v1/magpie/usage/requests?period=7d&limit=500&offset=…
Authorization: Bearer <provider key>
```

Each row carries `callerKeyId`/`callerKeyName`, `provider`, `providerAccount`, time, tokens,
cost and TTFT. The local server pages through them, keeps `REMOTE_CALLERS` (default
`cloud,Magpie`), and aggregates. There is no second service, no `/usage2`, and no page key to
manage.

## How the local side chooses the source

`ATTRIBUTION=auto` (default) reads `MAGPIE_PROVIDERS` (default
`~/.config/magpie/providers.json`), finds `preset: "remote-magpie"` providers, and races their
first page (a second domain is often unreachable). `ATTRIBUTION=local` keeps attribution on
this machine's `usage.jsonl` instead.

| Variable | Default | Meaning |
|---|---|---|
| `ATTRIBUTION` | `auto` | `auto` uses the remote magpie when configured; `local` never leaves this machine. |
| `MAGPIE_PROVIDERS` | `~/.config/magpie/providers.json` | Where the remote URL and key are read from. |
| `REMOTE_BASE` / `REMOTE_KEY` | empty | Explicit remote override; when set, `providers.json` is not read. |
| `REMOTE_CALLERS` | `cloud,Magpie` | Caller names to keep; other callers (e.g. `hermes`) still appear in the caller breakdown but not in the charts. |

The fetch is cached for 5 minutes. The first 7-day load is ~10 s (12 pages of 500 rows); a
cached load is instant. 30 days is ~26 pages. `prepack` refuses to package a stray `remote.js`
or a page key.

The page degrades in three states: no remote source (`source: "local"`) → remote cards hidden;
configured but the fetch fails → a red error card; success → normal data. A dead source must
never silently disappear.

## Optional: a standalone board view

You do **not** need this for attribution. It is only if you want to open the board on another
machine (or a public host) without magpie. It carries the same `static/` and `server.mjs`, and
is exposed under its own path/domain.

`vps-init.sh` unpacks `TARBALL` (default `/tmp/dashboard.tgz`) into the install directory
before writing the unit, and exits with an error if the archive is missing. Build it first,
from a checkout of this repository:

```sh
git archive HEAD -o /tmp/dashboard.tgz
```

Then run the installer:

```sh
PAGE_KEY=$(openssl rand -hex 16) ALLOWED_HOSTS=dash.example.com ./vps-init.sh
```

The unit lives at `/opt/magpie-usage`, `HOST=0.0.0.0`, `USAGE_JSONL` pointing at that
machine's magpie log. `HOST=0.0.0.0` without `ALLOWED_HOSTS` answers `403 invalid host`; put
the proxy name in `ALLOWED_HOSTS`.

A public instance never serves the board anonymously: `GET /` without `?key=…` answers `401`.
Open it once with the key and bookmark that URL. On a loopback bind the key is injected into
the page, so the local plugin never needs a URL token.

## Rotating keys

- **Local plugin** (`127.0.0.1`): delete `~/.config/magpie/usage-page-key` and restart the
  plugin; a new key is generated and injected. No URL changes.
- **Standalone board** (optional): change `PAGE_KEY` in the unit (or delete the drop-in) and
  restart; bookmarked `?key=` URLs stop working.
- **Remote provider key**: managed by magpie in `providers.json` and the remote
  `caller-keys.json`; the board only reads it.

## Deploying

```sh
RUNTIME_DIR=~/.config/magpie/my-usage-page bash deploy.sh local
# optional standalone board:
VPS_HOST=myvps VPS_DIR=/opt/magpie-usage bash deploy.sh vps
```

`deploy.sh` never embeds credentials. The page in the package has no key; the service injects
it into the served HTML on a loopback bind.
