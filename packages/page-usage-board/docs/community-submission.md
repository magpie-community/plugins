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

`npm pack` ships what the `files` field in package.json lists — which already includes the
runtime, `docs/`, `scripts/` (the `prepack` guard lives there) and `NOTICE`. The `prepack`
hook also asserts the checkout contains the `Dockerfile`/`docker-compose.yml`/`.env.example`
trio that `docs/docker.md` tells readers about, and validates every relative link in
README.md and `docs/*.md`.

Correct layout for `packages/page-usage-board/`: the `npm pack` output, plus `LICENSE`,
`Dockerfile`, `docker-compose.yml`, `.env.example`, `test/` and `deploy.sh` (development
files the README references — they do not need to be in `files`).

Check before opening the PR:

- `docs/` and the Docker files are in the staged tree.
- Every relative link in README.md and `docs/*.md` resolves inside
  `packages/page-usage-board/` — click through them in the GitHub PR preview.

## Checks before opening the PR

- `npm test` passes (auth, `Host`, traversal, lead-page, package metadata).
- `npm pack --dry-run` contains no `remote.js`, no page key, and includes `LICENSE`.
- The host part guards every route with a token **and checks `Host`** (community requirement
  for pages that navigate to a local service). Deliberate anonymous exemptions, filed here
  for review: `GET /api/ping` (returns `{service,ok}`) and `GET /api/health` (returns
  `{ok,jsonl}` — liveness fingerprints, no data), the board page itself on a loopback bind
  with no public names declared (the token is injected into the served HTML rather than
  typed), and `/static/*` assets (the chart library and page assets — no data).
- The hosted page uses `window.magpie.service` when present, so a remote `magpie web`
  deployment keeps the frame under magpie's own origin and key.
- The lead page has no inline scripts (its only sources are magpie's `_magpie/bridge.js`
  and the plugin's `boot.js`) and fetches nothing; the board itself only calls its own
  service on `127.0.0.1` (plus two deliberate exceptions: Cloudflare's injected analytics
  beacon on proxied deployments, and brand-icon favicon downloads for the quota wall —
  cosmetic only).
- `magpie.permissions` is `[]`: the page reads nothing through the bridge.