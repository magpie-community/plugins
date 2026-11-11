# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the research desktop app by SpeedAI. It adds Codar's models to magpie as a provider, handles the daily check-in, and reports the account's points on the usage card.

## Features

- **Provider** — registers a `codar` provider with Codar's model list (17 models: the `auto` router plus the DeepSeek, GLM, GPT and Claude families). The list is embedded in `catalog.mjs` and refreshed from `GET /v1/codar/models` when signed in. Chat goes from magpie straight to Codar's gateway (`https://api.claw.speedai.com/v1`) — OpenAI-compatible for most models, Anthropic Messages for the Claude ones.
- **Sign-in** — two methods: “读取本机科搭令牌” (keyless: the plugin reads the desktop app's token file itself, read-only) and pasting a Codar access token.
- **Daily check-in** — `POST /v1/daily-sign`, once per rolling 24 hours. The answer reports the claim (including the points it added) or that the day was already claimed, and carries `until` (magpie ≥ 0.1.1795) so magpie re-asks exactly when the next claim opens.
- **Usage** — points (general + agent), today's check-in state, and any free-model activity still running. The general points are also reported as a wallet reading (magpie #3950) so routing has a figure for the account; if the first balance endpoint fails, the card still shows what the second one answered.

## Install

```bash
magpie plugin add magpie-plugin-codar                  # from npm
# magpie plugin add github:MisonL/magpie-plugin-codar  # or from GitHub
# magpie plugin add "$PWD"                             # or from a checkout
magpie plugin login codar      # pick "读取本机科搭令牌", or paste the token
```

Then select a `codar` model in magpie, and turn on its check-in under
Settings (设置) → 额度 (Quota) → 预热与签到 (warm-up & check-in) → 插件 (Plugins).

## Signing in

Codar keeps its JWT in its own config file:

- macOS / Linux: `~/.codar/config.json`
- Windows: `%USERPROFILE%\.codar\config.json`
- `$CODAR_HOME/config.json` when `CODAR_HOME` is set (the app honours it, and so does this plugin)

The value is `provider.speedai.token`. The “读取本机科搭令牌” method reads it for you — read-only, never written — and checks it has an account name and has not expired before saving it. To paste it manually:

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codar/config.json")))["provider"]["speedai"]["token"])'
```

The token carries the account name and an expiry (7 days after the app's last login). When it runs out the plugin says so instead of calling the API — open Codar once to refresh it there, then sign in again.

## Notes

- **Prices stay as magpie sets them.** Codar lists prices in CNY and magpie's cost column is USD, so the plugin reports no price of its own rather than inventing an exchange rate. magpie still prices models by what models.dev says their makers charge, and a per-model price you set in magpie overrides everything.
- **Reasoning levels are not mapped to variants.** The vendor's `reasoning.levels` describe request-body rewrites (`set`/`omit`) the desktop app applies itself; magpie's variants only name levels, so the models carry `reasoning: true` and no variants.
- **Free-model activities are reported, not claimed.** The one-time campaign claim is not a daily check-in; the plugin only shows the activities that are running.
- **Concurrency is 3 per model** (measured; the vendor publishes no figure). magpie queues requests past it, and the provider setting can raise it. If the catalog ever states `max_concurrency`, the plugin adopts it without a release.
- **The check-in is a text row, not a percentage** — a check-in is not an allowance that runs out. A wait it cannot use (missing, zero, past year 9999, or over a week) falls back to a 30-minute trust floor, so a rolling 24-hour window cannot lose the next claim.
- **Fallback list.** If `GET /v1/codar/models` cannot be reached, the provider keeps the embedded `catalog.mjs` and magpie marks the list as fallen back; its sizes may trail the live list, and the live list wins whenever it can be fetched. A model's reply ceiling is the vendor's own (`max_tokens.maximum` → `limit.output`), so magpie lowers over-asking requests instead of letting the vendor refuse them.
- Models you add to this provider yourself survive list refreshes; the vendor's entries follow the vendor. A provider name or `api` you set in magpie survives restarts.
- The plugin follows the vendor client's own reading rules (field spellings, body codes, the “already claimed” wording in both Chinese and English), omits times it cannot write down rather than guessing, and never prints credentials — error messages are scrubbed by the token's shape, and oversized vendor answers are refused while they are read.
- Requests match the desktop client's shape per path: Node's default `User-Agent` to the account, activity and catalog endpoints, a Go HTTP client's to chat. The `chat.headers` hook runs for every provider's requests, so it filters by provider id and touches only `codar` traffic.

## Development

```bash
node --test                       # the whole suite, no network
bun test                          # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check  # is catalog.mjs still what the vendor says?
node scripts/catalog.mjs          # regenerate it from the signed-in app
```

`catalog.mjs` is generated with the plugin's own reader (`catalogOf`), so the fallback and the live list are built by the same rules. Its exit codes keep failures apart: `0` nothing moved, `1` a record moved (`--check` only), `2` the vendor or the file could not be read — a failed run writes nothing and never empties the fallback. It needs a signed-in app, so it is a local command, not a CI step.

The suite also pins the formatting in `.editorconfig` (LF, one final newline, no trailing whitespace, two-space indent) — `test/style.test.mjs` walks the tree, so a new file is covered the moment it lands. `CONTRIBUTING.md` has the invariants the tests defend.

CI runs the suite on Node 18–24, on Bun across Linux / macOS / Windows, and on Node on Windows and macOS — the plugin reads a file under the home directory, and that is where per-platform differences show up.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); [CHANGELOG.md](CHANGELOG.md) records every release, and the release process is described in `CONTRIBUTING.md`.

## Licence

MIT.
