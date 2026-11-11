# magpie-model-quota

A magpie page that shows, per model, how many tokens are estimated to be left — merged across every account and every provider. It turns each quota window into tokens using the local usage history, splits that by each model's share inside the window, and adds the same model up across all accounts.

Works entirely on the machine that runs magpie. No telemetry, no network requests except to the local magpie gateway.

## Install

From npm (after this package is published):

```
magpie plugin add magpie-model-quota
```

From a GitHub repository:

```
magpie plugin add github:<owner>/magpie-model-quota
```

From a local folder:

```
magpie plugin add ./magpie-model-quota
```

Then open the **Model Quota** page from magpie's Plugins section. A folder plugin is loaded where it is; after editing its files, turn the plugin off and on once.

## What it does

- Reads the local magpie files `usage.jsonl` (one line per request, with token counts) and `quota-history.json` (the remaining percentage of every quota window over time).
- For each quota window, measures "how many tokens one percent of the allowance is worth" from the percentage drop and the tokens consumed in the same interval, using the median over the complete rounds.
- Multiplies that by the remaining percentage to get the window's remaining tokens.
- Splits the window's remaining tokens by each model's share of the tokens used in that window.
- Adds the same model across accounts and providers, so the table is one row per model.
- Estimates "roughly how long it lasts" from each model's average daily consumption over the last 7 days.

Token count means input + output + cache read + cache write + reasoning.

## How the numbers are handled

- Rate windows of one account are nested: `5 hours` limits the momentary speed, while `7 days` / `Month` / `Weekly` is the overall allowance. The overall allowance is the longest window. If that window is used up, the account is not counted.
- When a `Total` / `总积分` window exists, only that aggregate is used; `Credits` / `Extra credits` and the individual packages are not added again.
- Model names that differ only by a context suffix (`grok-4.7@500k`, `grok-4.7@256k`, `claude-fable-5-1[1m]`) are merged into one model.
- A window whose current round has far fewer recorded requests than its history is marked **estimated from history rounds**. Its token number comes from the complete rounds.

## Data sources

- Current allowances: `GET /v1/magpie/quotas?kept=1` on the local gateway; falls back to `~/.config/magpie/quotas.json`.
- History readings: `~/.config/magpie/quota-history.json` (magpie keeps 45 days).
- Per-request usage: `~/.config/magpie/usage.jsonl`.

## Limits

- Quotas are kept per account and per window, not per model. A model's remaining tokens inside a shared window is an estimate based on its share of the window's usage.
- Windows that only expose a percentage have no absolute token count; the token figure depends entirely on the conversion derived from history.
- Accounts whose requests bypass magpie (for example Codex with `keepLogin` / switch-only, which talks to OpenAI directly) leave no per-request rows in `usage.jsonl`. Their windows can still show a percentage, but the token estimate has to come from older complete rounds, or is skipped.
- The estimate is extrapolated from history. A change in usage structure (longer sessions, different cache hit rate) shifts the result.

## Security

The page service binds `127.0.0.1` only. Every `/api` route except `/api/ping` requires a key generated fresh at each start and injected into the HTML this instance serves. The HTML is returned only to navigation requests, so another page cannot fetch it to read the key. Requests from another origin are refused; a sandboxed frame's `Origin: null` is accepted only together with the key. There is no telemetry, and the only request the service makes is to the local magpie gateway.

## Options

The page service listens on `127.0.0.1:3497` by default. If that port is taken, set another one in the plugin's options:

```json
{ "port": 3497 }
```

## Development

```
node test.mjs
```

Requires the magpie gateway on `127.0.0.1:3425`, or set `MAGPIE_ADDR`. The plugin has no runtime dependencies.

## License

MIT. See [LICENSE](LICENSE).
