## 中文说明

在 Magpie 窗口中按 **供应商 -> 账号 -> 模型** 查看用量，逐级展开调用、错误、
Token、缓存和费用。它补充「用量速览」没有的账号层：数据由插件自己的本地服务
向 Magpie 网关查询，页面不直接读取 Magpie 的配置文件。

# @magpie-community/page-usage-tree

## English

A page in Magpie's window that shows usage as a three-level tree:
**provider -> account -> model**. Each level expands into the next, with
calls, errors, tokens, cache and cost at every level.

Usage Glance (`@magpie-community/page-usage`) shows totals and per-model usage
from `usage:summary`. This page adds the provider -> account -> model tree,
including calls, errors and cost for each account. `usage:summary` deliberately
contains no per-account data, so this page asks Magpie's local gateway for the
usage it already counted.

```sh
magpie plugin add @magpie-community/page-usage-tree
```

## Architecture

- `page/index.html` and `page/boot.js` are the launcher Magpie sandboxes. They
  read the theme, language, page options and theme tokens, then navigate the
  frame to the local service. They never probe it first: a plugin page's CSP
  uses `connect-src 'none'`.
- `ui/app.html`, `ui/app.js`, `ui/view.js`, `ui/i18n.js` and `ui/style.css` are
  the page, served by the local service. It uses Magpie's own `--magpie-*`
  colours, font and control shapes.
- `index.mjs` is the OpenCode v1 host part. The service runs inside Magpie's
  plugin host, so it stops when Magpie stops the plugin.
- `magpie.page.service` lets the same page work through `magpie web`.
- `lib/gateway.mjs` asks the gateway for `GET /v1/magpie/usage?period=...` and
  `GET /v1/magpie/usage/requests?period=...&account=...`. The gateway applies
  Magpie's own accounting and pricing before this page groups the answer.
- No CLI is started, no `providers.json`, `settings.json`, `fxrate.json` or
  `usage.jsonl` is read, and there is no ledger fallback.
- Each period's aggregate is cached under
  `~/.cache/magpie/usage-tree/<period>.json`. A page shows the last read at
  once and the service reads again behind it. Refresh (`fresh=1`) reads past
  the cache. The page opens on today.
- Calls and errors are Magpie's: a try handed on to another account is not a
  call of its own, and API-key calls are a clearly marked group, not an
  account. Session-file rows are included because the gateway counted them.
- The page speaks Chinese and English. Every other language falls back to
  English, and the launcher follows the window's language too.

## Currency and units

The gateway reports cost in USD, Magpie's default. The page shows `$` unless
the page options explicitly set `currency: "cny"` and a `usdCny` rate; only
then does it convert for display. Token counts use `K`, `M` and `B`; Chinese
`万` and `亿` are used only when the language is Chinese and
`chineseUnits` is on.

## Token measure

`Tokens include cache` is on by default. It controls whether cache reads and
writes are part of the token measure used by the summary, row values, token
shares and token sorting. Turning it off leaves the input + output total
visible while keeping cache in the detail line. The page remembers the choice.

## Security

- Listens on `127.0.0.1` only.
- Uses a random token for every `/api/tree` and `/api/settings` request.
- Checks `Host` and `Origin`; the local sandbox's opaque origin is allowed for
  the page API. CORS preflight is answered for both page APIs.
- Reads nothing from Magpie's configuration files. It only calls the local
  gateway.
- Aggregation stays local; no data is uploaded.
- If another copy of this plugin owns the port, `/healthz` says which version
  it is. The same build is reused. A different build, or another service, is
  reported as an occupied port and is never killed: the listener may be the
  plugin host that serves every plugin.

## Options

```json
{
  "port": 3494,
  "currency": "usd",
  "chineseUnits": false,
  "usdCny": 0
}
```

`currency: "cny"` also needs `usdCny` for a meaningful conversion. Without a
rate the page keeps showing USD rather than inventing one.

## Run and test

```sh
node serve.mjs --port 3494
node --test --test-force-exit test/*.test.mjs
```

`test/parity.test.mjs` compares the gateway aggregation with
`magpie usage 7d` when a CLI and gateway are available. API-key groups are
excluded from the account-count comparison because Magpie's accounts table
does not list them.

`test/lifecycle.test.mjs` checks that the same build reuses a running service,
that another build is reported and left running, and that a host on its way
out releases the port.
