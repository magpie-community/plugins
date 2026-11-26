# eazydata

A [magpie](https://usemagpie.ai) provider plugin for **eazydata**
(<https://eazydata.org>) — an OpenAI-compatible relay that fronts many model
families behind one base URL and one API key.

What the plugin adds beyond a plain `providers.json` entry:

- **The model list, read for real.** eazydata documents no fixed catalogue, so
  the plugin reads `GET /v1/models` for the signed-in account and offers
  exactly what that key may call. A model added upstream works without a new
  release; a model the plugin has never seen gets a generous generic shape
  (text + image in, tools on, 128K context) rather than being dropped.
- **The dollar balance, read for real.** The relay reports no usage headers;
  what it exposes to a key is the OpenAI-style billing pair,
  `GET /v1/dashboard/billing/subscription` (`hard_limit_usd`) and
  `GET /v1/dashboard/billing/usage` (`total_usage`, in cents), so `usage`
  calls them and shows a **USD balance** window ("$99.96 left of $100"). It is
  a cumulative balance, not a daily token bucket, so there is no reset time.
  Nothing is made up: when the routes cannot be read, the window shows a
  descriptive line and no percentage instead of 0%.
- **A working rest on a spent balance.** When the balance is out and the relay
  answers 429 without a `Retry-After`, the plugin adds a moderate one so the
  key is not hammered; a plain concurrency 429 keeps the relay's own short
  `Retry-After`.

## Install

```sh
magpie plugin add ./eazydata
# or, once published: magpie plugin add eazydata
magpie plugin login eazydata
```

Then pick an `eazydata/<model>` as an agent's model.

### Provider id

The plugin signs in to the provider id **`eazydata`**. If a hand-written
`eazydata` provider already exists in `providers.json`, rename it first, or sign
in with `magpie plugin use` after adding both — two plugins claiming one id are
served one at a time (the chosen one, else the one added last).

## Sign-in

One API key from <https://eazydata.org>. The key is checked with
`GET /v1/models` before it is saved:

- rejected by the relay → the sign-in fails with the relay's own words;
- relay unreachable → the key is kept anyway, so a network blip cannot lock you
  out.

Keys are stored by magpie in `plugin-auth.json` under `eazydata`, and one key is
one account: sign in again with a second key and it is kept as
`eazydata#xxxxxx`, each with its own allowance and concurrency. `magpie plugin
logout eazydata` forgets it.

## Endpoints (lines)

eazydata advertises four OpenAI-compatible base URLs:

| Line | Base URL | Note |
| --- | --- | --- |
| 主站 (main) | `https://eazydata.org/v1` | Default. Optimized route, fast inside mainland China. |
| 备用 (backup) | `https://zzz.kkpliu.top/v1` | Fallback relay. |
| 备用 (China) | `https://cn.eazydata.org/v1` | Recommended for mainland China users. |
| 带文件 / 超时 (upload) | `https://upload.eazydata.org/v1` | Use on 499/524 after a timeout. |

The plugin uses the **main** line by default. To switch lines, pass a `baseURL`
option when instantiating the plugin, e.g.
`EazyDataPlugin(input, { baseURL: "https://cn.eazydata.org/v1" })`, or override
the provider's `api` in `providers.json`. All four are exported as `LINES` from
the package.

## Models

There is no baked-in list. `config` publishes a single placeholder entry
(`eazydata-default`) so magpie has a provider before a key is signed in; once an
account is signed in, `provider.models` replaces it with the account's real
`GET /v1/models` listing. Tokens are billed against the plan allowance, not in
money, so every model carries a zero money cost.

## What it does not do

No check-in (the relay has no daily-claim endpoint) and no sign-in state to
refresh — a 401 means the key was revoked, which the plugin reports as
`signIn: "expired"`.

## Layout

```
index.mjs          the entry magpie loads
opencode.mjs       the OpenCode 1.x face
opencode2.mjs      the OpenCode 2.x face (byte-identical to the community copy)
src/index.mjs      the plugin: config, auth, provider.models
src/models.mjs     the generic model shape + the account's live listing
src/quota.mjs      billing routes → a dollar balance window
test/              the tests, run by `npm test`
```

## Development

```sh
npm test          # every test, no network
npm run check     # syntax check + tests
```

The tests use a `fetch` double; nothing talks to the relay.

## Licence

MIT.
