# magpie-synthetic-provider-plugin

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider plugin for [Synthetic](https://synthetic.new). Signs in with a Synthetic API key, serves its models, and reports subscription usage to `magpie quota` through magpie's `auth.usage` hook.

## Usage

```sh
magpie plugin add <path-or-spec>
magpie plugin login synthetic   # paste your Synthetic API key
magpie provider test synthetic
magpie quota                    # synthetic · 5h n% ↻… · weekly n% ↻…
```

## What it reports

`GET https://api.synthetic.new/v2/quotas` (free — does not count against limits) maps onto magpie usage windows:

| Quota lane | Window | Meaning |
| --- | --- | --- |
| `rollingFiveHourLimit` | `5 hours` | Burst request limit; refills ~5% every 15 min (`nextTickAt` is shown as the countdown) |
| `weeklyTokenLimit` | `weekly` | Weekly credit budget; `used = 100 − percentRemaining` |
| `search.hourly` | `search / hour` | Hourly search quota (informational, `aside`) |
| `subscription` | `billing period` | Legacy per-period request counter (informational, `aside`) |

## API used

- Chat: `https://api.synthetic.new/anthropic/v1` (Anthropic Messages; `@ai-sdk/anthropic`). magpie injects the key itself as `x-api-key`
- Models: `GET https://api.synthetic.new/openai/v1/models` per account (the anthropic endpoint has no `/models` route). The anthropic API only accepts catalog `hf:` model ids, so alias keys (`syn:*`, `infinite:*`) send the `hf:` id of the catalog entry with the same `hugging_face_id`; falls back to the `syn:*` aliases
- Quotas: `GET https://api.synthetic.new/v2/quotas`

## Development

```sh
npm test   # node --test test/
```

Entry is `index.mjs` (plain ESM, also loadable by Bun in the magpie plugin host). Helpers for tests live on `export const _internal`.
