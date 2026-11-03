# @magpie-community/page-usage-tree

A page in magpie's window: usage as a three-level tree —
**provider → account → model** — each level expandable into the next, with
calls, errors, tokens, cache and cost.

It does not replace Magpie's built-in Usage page, and it reads nothing of
magpie: no `magpie.read`, no sign-ins, no keys.

```sh
magpie plugin add @magpie-community/page-usage-tree
```

It does not replace Magpie's built-in Usage page and does not modify the existing
Usage Glance plugin.

## Architecture

- `page/index.html` and `page/boot.js` are the launcher Magpie sandboxes. It
  only reads the theme and the plugin's `port` option, then navigates its own
  frame to the local service. It never probes the service first, because a
  plugin page's CSP uses `connect-src 'none'`.
- `ui/app.html`, `ui/app.js`, `ui/view.js`, `ui/i18n.js` and `ui/style.css` are the real
  page, served by the local service. It takes Magpie's own look: the window's
  `--magpie-*` colours and font come in through the launcher, and every layout
  rule here is written in those tokens.
- `index.mjs` is the OpenCode v1 host part. The service runs inside Magpie's
  own plugin host, so it stops when Magpie stops the plugin, and an update
  brings the new build up instead of leaving the old one on the port.
- The launcher navigates its frame to that service, as Magpie's documented page
  service pattern permits. It never probes the service first because plugin page
  CSP uses `connect-src 'none'`.
- `magpie.page.service` lets the same page work through `magpie web`.
- The service reads `magpie usage --csv <period>` and falls back to the local
  `usage.jsonl` if the CLI cannot be started.
- Each period's aggregate is cached under `~/.cache/magpie/usage-tree/<period>.json`.
  The log changes with every call, so a page is never made to wait for a read:
  it shows the numbers of the last read at once and the service reads again
  behind the page, which then catches up on its own. Refresh (`fresh=1`) reads
  again past the cache. The page opens on today.
- Accounts are the provider and the subscription account that answered, named
  by the user's own `accountNames` from `providers.json` when set. Models under
  an account are told apart by host account exactly as Magpie's own usage
  tables do, so the numbers reconcile with `magpie usage 7d`.
- Calls and errors count as Magpie counts them: a try that was handed on to
  another account is no call of its own, and a call made with an API key is
  shown in a clearly marked "API key" group, not as an account.
- The page follows Magpie's language, currency and number units: it speaks
  Chinese and English, and reads the currency and the `chineseUnits` choice
  from Magpie's own settings, changing to them as they change.

## Security

- Listens on `127.0.0.1` only.
- Uses a random token for every `/api/tree` request.
- Checks `Host` and `Origin`; the local sandbox origin is explicitly allowed for the page API.
- Reads only `usage.jsonl`, `settings.json` (currency) and `providers.json`
  (the account names the user gave). Not `logins.json`, not `caller-keys.json`.
- Aggregation stays local; no data is uploaded.
- If another copy of this plugin already owns the port, `/healthz` says which
  version it is: the same build is reused, an older one is stopped and its
  port taken over.

## Options

```json
{
  "port": 3494
}
```

The currency and the rate behind it come from Magpie's own settings and cache,
so the numbers here are the ones Magpie shows.

## Run and test

```sh
node serve.mjs --port 3494
node --test test/*.test.mjs
```

`test/parity.test.mjs` compares this aggregation with `magpie usage 7d` on the
same machine: account call counts and per-provider/model call counts must match.
`test/lifecycle.test.mjs` checks that a newer build takes the port from an
older one.
