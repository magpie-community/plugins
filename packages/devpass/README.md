# @magpie-community/opencode-devpass-auth

DevPass by [LLM Gateway](https://llmgateway.io) in OpenCode and magpie. One provider accepts a DevPass Lite, Pro or Max key and an ordinary LLM Gateway pay-as-you-go key.

**Provider id:** `devpass`

## Sign in

Choose **DevPass (browser)** to open LLM Gateway's DevPass authorization page. The plugin uses the official PKCE loopback flow: approve the Magpie connection in the browser and DevPass creates a key for Magpie, without copying it through the callback URL. The authorization flow identifies itself with the supported `openai-sdk` source because LLM Gateway does not currently recognize Magpie as a CLI source; the dashboard connection name remains Magpie, while inference requests still use `X-Source: usemagpie.ai`. Alternatively, create or reveal an `llmgtwy_…` key in the [DevPass dashboard](https://devpass.llmgateway.io/dashboard), or use a regular LLM Gateway key. The host keeps it as `{ "type": "api", "key" }` in magpie's `plugin-auth.json` or OpenCode's `auth.json`; this package does not write credentials elsewhere.

Every inference request goes to `https://api.llmgateway.io/v1` with both `Authorization: Bearer <key>` and `x-api-key: <key>`. The plugin supplies `X-Source: usemagpie.ai` when the caller did not provide a source. Responses, including streams, costs, routing metadata and error bodies, pass through unchanged. A `401` marks the account for sign-in again; quota, permission and upstream failures keep their own status and do not incorrectly sign the account out.

## Models and protocols

The account's live `GET /v1/models?exclude_deprecated=true` catalogue supplies canonical, unprefixed model ids. DevPass chooses the upstream provider; provider-pinned ids are intentionally not offered. Virtual routers, deactivated models, non-text output models and models without tool calling are excluded.

The model family selects the wire API:

| Family | Protocol |
| --- | --- |
| OpenAI | OpenAI Responses |
| Anthropic | Anthropic Messages |
| Everything else | OpenAI Chat Completions |

The catalogue's display names, context/output limits, modalities, tool support, reasoning efforts, service tiers and per-token prices are mapped to the host's model shape. Prices are converted to USD per million tokens. A failed catalogue read keeps the previous model list; a refused key asks for sign-in again.

## Usage and limits

`GET /v1/key` distinguishes a plan key (`devPlan: lite`, `pro` or `max`) from a pay-as-you-go key (`devPlan: none`) without a dashboard session. DevPass cards show:

- **Daily allowance** — the rolling 24-hour pacing window, its dollar usage and reset time.
- **Premium weekly** — the seven-day fair-use window. Models below DevPass's published premium price thresholds are excluded from this window in routing.
- **Monthly allowance** — informational current-cycle usage. No fixed 30-day reset is invented because the API does not report the billing-cycle end.

When a rolling window has not started, its reset time is absent rather than guessed. A pay-as-you-go card shows the key's all-time usage and its optional key limit. The plugin does not estimate an overflow balance or bypass an upstream limit.

## Install

```sh
magpie plugin add @magpie-community/opencode-devpass-auth
magpie plugin login devpass
magpie provider test devpass
magpie quota
```

For a local checkout, use `magpie plugin add ./packages/devpass`. In OpenCode, add `@magpie-community/opencode-devpass-auth` under `plugin`, then run `opencode auth login`.

Embeddings, image generation and video generation are outside this chat-provider plugin's scope and are not included in DevPass coding plans.

## Development

```sh
bun test packages/devpass
bun scripts/check.mjs devpass
```

MIT. Not affiliated with LLM Gateway.
