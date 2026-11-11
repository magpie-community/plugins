# magpie-freepi

English · [简体中文](README.zh.md)

A [magpie](https://usemagpie.ai) provider plugin for [free-pi](https://freepi.ai) (`api.freepi.ai`), the ad-supported free model gateway. Talks straight to the upstream — no local proxy, no extra process.

Unofficial; the protocol was reverse-engineered from free-pi-cli (same shape as [FreePi2API](https://github.com/ErfanBagheri404/FreePi2API)).

## Features

- **Direct upstream**: credentials live in magpie's `plugin-auth.json` (mode 600); requests ride magpie's proxy chain for this provider (switchable to direct via options).
- **GitHub device-code sign-in**: click login in the app, enter the code in your browser — no API key.
- **Live model catalog** (26 available models at the moment) with free/usage-rate badges from the upstream, falling back to a built-in static list when unreachable.
- **Real daily quota**: the account card shows free-pi's daily credits and its UTC-midnight reset, so routing can weigh the account.
- **Automatic ad impressions**: free-pi only serves completions when the client reports banner impressions; the plugin fetches one banner and reports the impression before each request (never clicks, never blocks, failures are swallowed). The count is visible on the account card.

## Install

```sh
magpie plugin add magpie-freepi-auth              # from npm
magpie plugin add github:aqiu817/magpie-freepi    # or from GitHub, or a local folder path
magpie plugin login freepi                        # finish the GitHub device flow in your browser
magpie provider test freepi
```

In the app: Plugins → Add → enter the package name / repo / path → sign in on the freepi row.

## Models

Check the live list in magpie's model picker. **Every model consumes the daily credits allowance at its usage rate** — the former free-unlimited promotion has ended. The upstream name carries the rate and the plugin converts it to a badge:

- `deepseek-v4-flash` / `particle` (~1x) are the cheapest everyday picks, `glm-5.3-flash` ~1.5x, `solar-pro-4` ~0.6x
- Premium models run 2–60x (`claude-haiku-5.5` 2x, `deepseek-v4-pro` 18x, uncensored/abliterated fine-tunes 20–60x), and `deepseek-v4.1-flash-1017-ultrafast` burns ~295x — watch the badge before selecting
- Occasional free promotions (🔥 Free Unlimited) still appear from time to time; when one is active the plugin flags those models as free automatically

Your remaining daily credits (currently 15,000, resetting at UTC midnight) show on the account card and in `magpie quota`.

Context/output limits come from [models.dev](https://models.dev) (matched via the upstream `stats_id`): most models are ~1M context; unmatched entries default to 128k/16k. The upstream may still cap per request.

## Options

Set as JSON under Plugins → Installed → freepi options (or `magpie plugin options freepi '{"direct":true}'`):

| Option | Default | Description |
|---|---|---|
| `direct` | `false` | Bypass magpie's proxy chain and hit the upstream directly |
| `adCount` | `true` | Show an aside window with this run's reported impression count (never used by routing) |

## Disclaimer

- **Unofficial**: not affiliated with free-pi; the protocol is reverse-engineered and consent/version/ad endpoints may change and break at any time.
- **Ads**: free-pi pays for inference with ad revenue. The plugin mirrors what headless proxies do — report banner impressions automatically (impressions only, never clicks). Use the official CLI if you'd rather support the service with real browsing.
- **Data**: the upstream marks `muse-spark-1.3-contributor` as training on your data (free-pi + Meta), and sign-in requires consenting to sessions possibly being used for training.
- **Quota**: rated models consume daily credits per the upstream's rules; exhausted credits fall back to a slower lane or a wait.
- Personal use only.

## Development

```sh
node --test test/freepi.test.mjs
```

```
index.mjs            # entry: FreePiPlugin (the only plugin export) + _internal
lib/upstream.mjs     # upstream contract: constants/version pin/headers/device flow/ad gate
lib/catalog.mjs      # static model table + catalog parsing + models.dev limits
test/                # node:test with mocked fetch, no real network
```

## License

MIT
