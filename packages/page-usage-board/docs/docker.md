# Docker and public deployment

This image is a **standalone viewer**. A local magpie board gets remote attribution straight
from the remote magpie's usage API, so it does not need this container.

The image runs the standalone service (`server.mjs`) — no magpie is required on that machine.
It is useful as a board on a VPS or another machine with a mounted `usage.jsonl`.

```sh
docker compose up -d --build
curl -s http://127.0.0.1:3456/api/health
```

The compose file publishes the port on `127.0.0.1` only. That is deliberate: a public server
should have a reverse proxy in front, and the app should not be reachable directly.

## What it reads

| Path in container | Host path | What |
|---|---|---|
| `/magpie/usage.jsonl` | `${MAGPIE_CONFIG}/usage.jsonl` | usage log (required for data) |
| `host.docker.internal:3425` | magpie's gateway | live quotas/KPIs (optional; charts still render from the log) |
| `/data` | named volume | generated logos and the persisted page key |

Set `MAGPIE_CONFIG` in `.env` or the shell:

```sh
MAGPIE_CONFIG=/opt/magpie/config/magpie docker compose up -d --build
```

On a machine where magpie runs in a different network namespace, point `GATEWAY` at the
reachable address instead of `host.docker.internal`.

## Mode A — the proxy authenticates (recommended for public hosts)

Leave `PAGE_KEY` empty, put Caddy/nginx/Cloudflare Access in front, and keep the container
port on loopback. The proxy is the gate; the app trusts it.

This empty value is an explicit off switch, not an omission: the compose file passes
`PAGE_KEY: "${PAGE_KEY:-}"`, so the container always sees the variable defined, and an empty
value disables the app's own token check. That is intended in Mode A — under compose the
service never auto-generates a key.

```sh
ALLOWED_HOSTS=dash.example.com docker compose up -d
```

```caddyfile
dash.example.com {
    basic_auth {
        you <bcrypt-hash-from: caddy hash-password>
    }
    reverse_proxy 127.0.0.1:3456
}
```

Then open `https://dash.example.com/` — no key in the URL, nothing to paste.

`ALLOWED_HOSTS` must contain the name the proxy forwards in `Host` (`dash.example.com`
above). Without it, the service answers `403 invalid host` by design (DNS-rebinding guard).
Loopback names (`127.0.0.1`, `localhost`) are accepted with **any** port — port mappings
(`127.0.0.1:3456:3455`), tunnels and a proxy that rewrites `Host` to `127.0.0.1` all work
without `ALLOWED_HOSTS`. Public names are never accepted by port alone.

Page gate note (Mode B): with a `PAGE_KEY` set, the board page itself requires the token on
standalone deployments **even when the proxy rewrites `Host` to `127.0.0.1`** — the
anonymous injected page is reserved for plugin mode, where the magpie host is the outer
gate. A proxy-fronted Mode B therefore needs `ALLOWED_HOSTS` (or the bookmarked `?key=`
URL, which sets the cookie).

## Mode B — the app authenticates

Under compose, leaving `PAGE_KEY` unset does not generate a key — it disables auth (see
Mode A). Set the key in `.env` next to `docker-compose.yml`:

```sh
# .env
PAGE_KEY=<output of: openssl rand -hex 16>
ALLOWED_HOSTS=dash.example.com
```

```sh
docker compose up -d
```

Open `https://dash.example.com/?key=<the value of PAGE_KEY>`. The page stores the key in a
cookie, so later visits to `/` work without the query string.

The "generates a key and prints the full URL" path never happens under compose. It only
applies to a bare `node server.mjs` (or systemd) start where `PAGE_KEY` is entirely
undefined; there the first-start log is the only place to read the key:

```sh
node server.mjs | grep 'open http'
```

Such a generated key is persisted (`PAGE_KEY_FILE`, `/data/page-key` in the container), so
restarts do not invalidate bookmarks. Rotate it by removing that file and restarting, or by
changing `PAGE_KEY`.

## Do not expose the port directly

`ports: "0.0.0.0:3456:3455"` without a token publishes your usage, quota and account detail
to anyone who finds the port. Under compose, leaving `PAGE_KEY` unset counts as "without a
token": the compose default passes an empty string, which disables auth rather than making
the service generate one. Either:

- keep `127.0.0.1:3456:3455` and put a proxy with auth in front (Mode A), or
- publish it and set a strong `PAGE_KEY`, accepting the keyed URL (Mode B).

The service always checks `Host`; a public bind without `ALLOWED_HOSTS` only accepts loopback
names, so a direct public request fails closed.

## Health and logs

- `GET /api/health` is anonymous and returns only `{ok, jsonl}` — no gateway address, no data.
- The first-run URL and the effective port are in `docker compose logs`.
- Data is read-only from the container's point of view; `usage.jsonl` is never modified.