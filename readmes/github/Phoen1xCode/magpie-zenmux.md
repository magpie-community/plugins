# magpie-zenmux

Connects [ZenMux](https://zenmux.ai) to [Magpie](https://usemagpie.ai) with Builder Plan or Pay As You Go API keys. Provider id: `zenmux`.

The plugin discovers conversation models, routes requests through their native Messages or Responses API, and reports subscription quotas or PAYG balance with an optional Management API Key.

## Install

```sh
magpie plugin add github:Phoen1xCode/magpie-zenmux
magpie plugin login zenmux
```

This installs from the GitHub repository's default branch. In the app, add `github:Phoen1xCode/magpie-zenmux` on the **Plugins** page, then sign in to **ZenMux** from **Providers**.

## Sign in

One method, **ZenMux API Key (Builder Plan or Pay As You Go)**. The key prefix determines the billing type; there is no separate plan selection.

Magpie first asks for an optional Management API Key, then the inference API Key. Both fields are masked. Leave the Management Key blank if you only need model requests.

| Key | Prefix | Purpose |
| --- | --- | --- |
| Builder Plan (Subscription) | `sk-subs-` | Model requests charged to the subscription's Flows |
| Pay As You Go | `sk-payg-` | Model requests charged to PAYG funds |
| Platform Management | `sk-mgmt-` | Read subscription quotas or account balance; never used for inference |

The plugin only accepts these prefixes and requires **164 characters**, including the prefix. Keys are passed through without truncation. Old-format keys are rejected; replace any saved old keys before using this version.

Create keys in the [subscription console](https://zenmux.ai/platform/subscription), [PAYG console](https://zenmux.ai/platform/pay-as-you-go), or [Management console](https://zenmux.ai/platform/management). The Management Key should belong to the same ZenMux account as the inference key.

Magpie keeps the inference key in the account's `key` field and the Management Key in its metadata in `plugin-auth.json`. The plugin does not borrow another account's Management Key or read one from an environment variable. Saving a key is not a remote authentication check.

Run `magpie plugin login zenmux` again to add another account. Builder and PAYG accounts share one provider and the same model IDs.

To migrate, create replacement keys and sign in with them. Disable the old account in Magpie so requests use the replacement. Verify model requests and, if configured, quota or balance reads, then revoke the old keys in ZenMux once no other apps use them. Updating the plugin does not rotate saved keys.

## Models

Choose a model from Magpie's **Agents** page, for example:

```text
zenmux/anthropic/claude-sonnet-4.5
zenmux/openai/gpt-5.4
zenmux/deepseek/deepseek-v4-flash
```

The live list comes from ZenMux's `/api/v1/models`, cached for two minutes. Only text-output conversation models are offered; image, video and audio generators are excluded. This is a platform catalog, not a guarantee that a particular key or plan can use every model. ZenMux enforces access restrictions.

Missing metadata comes from [models.dev's ZenMux catalog](https://models.dev/providers/zenmux/), matched by the full model ID. ZenMux's explicit values take priority. The plugin supplements names, token limits, modalities, capability flags, reasoning levels and reference prices without changing the model's upstream protocol.

- Effort levels come only from `reasoning_options` entries of type `effort`. Toggle-only or token-budget models do not get invented effort levels.
- A model or field not yet synchronized to models.dev is left unset. No records are borrowed from other providers or guessed aliases.
- Supplementary metadata is fetched anonymously and cached for 30 minutes. If models.dev is unavailable, basic discovery and inference still work.

If the live ZenMux catalog fails, Magpie keeps its last successful listing. The plugin does not invent bootstrap models.

## Requests

| Model ID | Native ZenMux API |
| --- | --- |
| `anthropic/*` | Anthropic Messages: `/api/anthropic/v1/messages` |
| `openai/*` | OpenAI Responses: `/api/v1/responses` |
| Other conversation models | Anthropic Messages: `/api/anthropic/v1/messages` |

Every listed model can be called through Magpie's **`/v1/messages`**. Magpie converts OpenAI requests and replies to and from Responses; the plugin does not add another protocol translator. Some agents, including Pi, may still be automatically configured to use Responses for OpenAI models. The plugin does not override that choice.

The plugin preserves request bodies, tool calls, reasoning parameters, prompt-cache fields, JSON replies, response streams and cancellation. Messages uses `x-api-key`; Responses uses Bearer authentication. Client credentials are replaced with the selected account's inference key. No request is retried by the plugin, and redirects are not followed.

A `403 access_denied` marks the inference key as expired. Safety filters, exhausted quotas, insufficient funds and models outside the plan do not. Upstream statuses, error bodies and `Retry-After` are preserved by the plugin; Magpie may normalize errors when translating them for an agent.

## Quotas and balance

```sh
magpie quota zenmux
```

With a Management API Key, the account's card shows:

| Inference key | Reported information |
| --- | --- |
| Builder Plan | Plan, expiry, 5-hour and 7-day Flows used and total, percentages, natural reset times, and remaining early 5-hour resets |
| Pay As You Go | Total account balance in USD |

Results are cached for 30 seconds per endpoint and Management Key. Concurrent reads are coalesced; metadata requests time out after ten seconds. A missing, rejected or unreachable Management Key produces a warning without disabling inference.

Early resets are separate from a window's natural reset time. Zero is a valid remaining count; a missing count is not treated as zero. The plugin only reads reset entitlements and never spends one. Monthly quota is a ceiling without live usage, so it is not shown as remaining balance. PAYG balance is account-wide, not a key-specific budget, and excludes Token Packs.

### Prices and billing

models.dev's input, output, cache-read and cache-write prices are **USD-per-million-token references**, shared across accounts. They may lag ZenMux's prices and do not describe Builder Flow consumption or the final charge. Missing or invalid prices are omitted, not replaced with zero; explicit zero prices are preserved.

Magpie's plugin price card exposes one value per price kind. The plugin does not flatten context tiers or separate cache TTL prices into guessed values, or mark models as free from reference prices. Magpie's own compact price representation may still display an unspecified cache price as zero.

### Account selection

Magpie, not the plugin, chooses which enabled account serves a request. Its failover can move from a Builder account to a PAYG account. To require subscription-only spending, disable PAYG accounts and check Magpie's fallback groups and ZenMux's **Extra Usage** setting. The default concurrency limit is two requests per account, adjustable in Magpie.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Quota or balance unavailable | Add a valid Management API Key for that account. Inference does not require it. |
| New model has no effort levels or price | models.dev may not have synchronized it yet. Missing metadata is skipped. |
| Model is outside the subscription | Check the plan's model list in ZenMux; a public listing does not grant access. |
| Plugin accounts disappear | Keep account discovery enabled. `MAGPIE_NO_ACCOUNTS=1` disables plugin accounts too. |

## Development

Requires Node.js 22.12 or newer. There are no npm runtime or development dependencies to install.

```sh
git clone https://github.com/Phoen1xCode/magpie-zenmux.git
cd magpie-zenmux
magpie plugin add .
```

After editing a local installation, disable and re-enable the plugin in Magpie to reload it.

```sh
node scripts/check.mjs
npm test
npm run test:e2e
npm pack --dry-run
```

The syntax check covers `index.mjs`, `src/`, `tests/` and `scripts/`. `npm test` runs local fixture tests and skips the opt-in gateway tests. `npm run test:e2e` requires Magpie and Bun on PATH and exercises CLI sign-in, model metadata, quota cards, native routes, Messages and Responses JSON/SSE, tools, cancellation and credential separation. It uses invented keys, local upstreams and isolated HOME/XDG directories, not your saved accounts. Set `MAGPIE_BIN` or `MAGPIE_BUN` to use different executables.

For fixtures, `origin` overrides the ZenMux origin and `modelsDevOrigin` overrides the metadata origin. Both accept HTTPS origins or HTTP loopback origins; API paths stay fixed. Defaults are `https://zenmux.ai` and `https://models.dev`. Changing `origin` changes where credentials are sent. No inference or Management Key is sent to `modelsDevOrigin`.

Tests do not establish access to a real ZenMux model. To test one with your own enabled account:

```sh
magpie provider test zenmux deepseek/deepseek-v4-flash
```

## References

- [ZenMux model catalog](https://zenmux.ai/docs/api/openai/openai-list-models.html)
- [Anthropic Messages](https://zenmux.ai/docs/api/anthropic/create-messages.html) and [OpenAI Responses](https://zenmux.ai/docs/api/openai/openai-responses.html)
- [Subscription details](https://zenmux.ai/docs/api/platform/subscription-detail.html) and [PAYG balance](https://zenmux.ai/docs/api/platform/payg-balance.html)
- [models.dev ZenMux metadata](https://models.dev/providers/zenmux/)
- [Magpie plugin contract](https://usemagpie.ai/docs/plugins)

## License

[MIT](LICENSE)
