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
- `ui/app.html`, `ui/app.js`, `ui/view.js` and `ui/style.css` are the real
  page, served by the local service. It takes Magpie's own look: the window's
  `--magpie-*` colours and font come in through the launcher, and every layout
  rule here is written in those tokens.
- `index.mjs` is the OpenCode v1 host part. It starts a loopback-only service.
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

## Security

- Listens on `127.0.0.1` only.
- Uses a random token for every `/api/tree` request.
- Checks `Host`, `Origin`, and does not send CORS headers.
- Reads only `usage.jsonl`, `settings.json` (currency) and `providers.json`
  (the account names the user gave). Not `logins.json`, not `caller-keys.json`.
- Aggregation stays local; no data is uploaded.
- If another plugin host already owns the port, it verifies that the service
  there is this plugin's and reuses it instead of failing.

## Options

```json
{
  "port": 3488,
  "usdCny": 7.2
}
```

`usdCny` is only used to present approximate CNY values when Magpie's currency is
set to CNY. Raw usage cost comes from Magpie's CSV export.

## Run and test

```sh
node serve.mjs --port 3488
node --test test/*.test.mjs
```

`test/parity.test.mjs` compares this aggregation with `magpie usage 7d` on the
same machine: account call counts and per-provider/model call counts must match.
