# @magpie-community/opencode-taotoken-auth

Signs in to [TaoToken](https://taotoken.net) and serves its CodingPlan: the
plan's chat models through the coding gateway, and the plan's own usage
windows (5 hours / week / month) on the account's card.

| Provider id | API |
|---|---|
| `taotoken` | `https://api.taotoken.net/coding/v1` (OpenAI-compatible) |

The package exports `TaoTokenAuthPlugin` (`taotoken`).

## Signing in

Both inputs go on one sign-in form.

- **API key.** A key from [TaoToken's keys page](https://taotoken.net/console/api-keys),
  sent as `Authorization: Bearer` to the coding gateway. It serves the
  models; it does not read the plan's usage (the gateway answers 401).
- **Usage token (optional).** The value of the `token` cookie on
  taotoken.net while signed in (DevTools → Application → Cookies →
  taotoken.net → `token`), a JWT. The console API `GET /v1/plan/overview`
  accepts it as `Authorization` (or as the cookie). Without it the card
  shows no usage.

## Usage windows

`GET https://taotoken.net/api/v1/plan/overview` returns `data.codingPlan.buckets`
with the plan's counted requests: `5_hour`, `1_week` and `1_month`, each with
`used`, `quotaLimit`, `usagePercent` and `endTime`. They are mapped to the
card's three windows (5 小时 / 本周 / 本月), with the 5-hour window first
because magpie's account row renders the first two.

## Renewal

The login token lasts **30 days** (`exp - iat`), and TaoToken has no refresh
token and does not renew the cookie itself. The plugin keeps the card alive:

- it parses the JWT's `exp` and writes it into the account's `expires`, so
  magpie renews the sign-in through `auth.refresh` **7 days early**
  (`refreshLead`), and warns on the card and through magpie's toast/log
  within those 7 days;
- `auth.refresh` runs `scripts/capture-token.mjs`, which reads the freshest
  `token` cookie from a local signed-in browser over CDP (any Chromium-family
  browser started with `--remote-debugging-port`, e.g. Edge on 9222). When no
  browser answers, it returns nothing: the old token keeps being used and
  the account is not marked signed out.

`scripts/start-browser-debug.ps1 -Browser msedge|chrome|brave|arc|opera|vivaldi`
starts such a browser with its default profile (the sign-in is kept).
`scripts/refresh-token.mjs` renews by hand (`--dry-run`, `--auth <path>`, `--task`
prints a `schtasks` example), writing only `taotoken.metadata.loginToken`
into magpie's `plugin-auth.json` and backing it up first.

## Models

Before signing in the package lists `glm-5.3-flash` and `deepseek-flash`
(context 1M). After signing in, `GET /coding/v1/models` replaces the list
with the account's own.

## Development

`index.mjs` is the plugin: `config` declares the provider and models,
`auth.methods` signs in, `auth.loader` serves requests, `auth.usage` reads the
card (fresh on every magpie refresh, no caching), `auth.refresh` renews.
Zero runtime dependencies; scripts under `scripts/` are Node ESM.
