# Community submission

The community publishes packages by merging a pull request into
[`magpie-community/plugins`](https://github.com/magpie-community/plugins). Submitting is just
that PR — no dashboard form, and no manual `npm publish`: merging to the registry's main
branch bumps the version and **trusted publishing puts the package on npm automatically**,
so `package.json`'s `version` must be release-ready when the PR lands. One PR adds three
things:

1. `packages/page-usage-board/` — this package (all files from `npm pack`, plus `LICENSE`,
   `README.md`, `docs/` and the development files — see the layout trap below).
2. One entry in `registry.json`.
3. One row in the README's **Pages** table.

## registry.json entry

```json
{
  "package": "@magpie-community/page-usage-board",
  "name": "Usage Board",
  "kind": "page",
  "community": true,
  "summary": {
    "en": "A quota card wall with expiry tiers, daily/per-provider charts, 24h cache-hit and token curves, optional remote attribution and account detail. Runs its own zero-dependency local service reading this machine's Magpie usage data; optional remote attribution queries the configured remote magpie.",
    "zh": "额度到期卡片墙 + 每日与 provider 用量图表 + 24 小时缓存命中与 token 曲线，可选远端归因与账号明细。自带零依赖本机服务，读本机 Magpie 用量数据；远端归因会查询所配置的远端 magpie。"
  }
}
```

The `summary` above must stay **verbatim-identical** to `magpie.summary` in package.json —
copy it into the PR description together with the difference declaration (the registry
requires all three texts to match).

## README Pages row

```md
| [page-usage-board](packages/page-usage-board) | Full usage board: quota cards with expiry tiers, daily and per-provider charts, 24-hour cache-hit and token curves, optional remote attribution and account detail | none (the page reads nothing through the bridge; its local service reads your usage.jsonl, magpie's usage/quota API, and — for optional remote attribution — your magpie config's provider key to query the configured remote magpie) |
```

## The packaging layout

`npm pack` ships what the `files` field in package.json lists — the runtime (`index.mjs`,
`server.mjs`, `page/`, `static/`), the vendored echarts bundle (`build/echarts-entry.mjs` +
`static/echarts.min.js`), `docs/`, `scripts/` (`prepack.mjs`, `build-echarts.mjs`) and
`NOTICE`. The `prepack` hook asserts that the echarts entry and its build script exist and
are covered by `files`, and validates every relative link in README.md and `docs/*.md`.

Correct layout for `packages/page-usage-board/`: the `npm pack` output, plus `LICENSE`,
`.env.example` and `test/` (development files the README references — they do not need to
be in `files`).

Check before opening the PR:

- `docs/` and `.env.example` are in the staged tree.
- Every relative link in README.md and `docs/*.md` resolves inside
  `packages/page-usage-board/` — click through them in the GitHub PR preview.

## Checks before opening the PR

- `npm test` passes (auth, `Host`, page gate, traversal, lead-page, package metadata).
- `npm pack --dry-run` contains no `remote.js`, no page key, and includes `LICENSE`.
- The host part guards every route with a token **and checks `Host`** (community requirement
  for pages that navigate to a local service). The board page itself is served only on a
  loopback bind with a loopback `Host` name — the token is injected into the served HTML
  rather than typed, and a non-loopback bind or a proxied public `Host` never receives the
  page. Deliberate anonymous routes, filed here for review: `GET /api/ping` (returns
  `{service,ok,build,version}` — an identity fingerprint + build id, used to recognise a
  live instance of the same build) and `GET /api/health` (returns `{ok,jsonl}` — liveness).
  Both carry no key and no usage data; every other `/api/*` route requires the token via
  the `x-dash-key` header (no `?key=` query auth, no cookie channel), and `/static/*` holds
  only the chart library and page assets (no data).
- Remote attribution defaults to **off** (`magpie.options.attribution: "local"`); the user
  must explicitly opt in (`ATTRIBUTION=remote` or `options.attribution: "remote"`), which
  sends the configured provider key to the remote magpie and nowhere else. In that mode the
  service also reads the remote magpie's `providers[]` icon metadata and — only when that
  remote magpie stops aggregating its own account cards into `/v1/magpie/quotas` — its
  `/v1/magpie/quotas/cards`, so the quota wall keeps showing the remote accounts. Both are
  read-only requests to that same configured remote, with the same key; the fallback steps
  aside as soon as the gateway reports remote-line cards again.
- The hosted page uses `window.magpie.service` when present, so a remote `magpie web`
  deployment keeps the frame under magpie's own origin and key.
- The lead page has no inline scripts (its only sources are magpie's `_magpie/bridge.js`
  and the plugin's `boot.js`) and fetches nothing; the board itself only calls its own
  service on `127.0.0.1`. Its Content-Security-Policy allows no third-party host, and brand
  logos are data URIs assembled from magpie's local `plugin-providers.json` / `icons/` cache
  (remote provider mappings are read from the remote magpie only in remote-attribution mode)
  — the page never contacts a third-party CDN.
- `magpie.permissions` is `[]`: the page reads nothing through the bridge.
