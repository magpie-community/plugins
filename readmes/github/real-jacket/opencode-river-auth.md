# opencode-river-auth

River ([river.ai](https://river.ai)) with your API key in [OpenCode](https://opencode.ai) and
[magpie](https://usemagpie.ai). River serves an OpenAI-compatible inference API at
`https://api.river.ai/v1`; this plugin signs every request with your key, so agents reach its
models like any other provider — multi-account, fallback, quotas and all.

## What you get

- **Sign-in**: a River API key, created on the [API Keys](https://console.river.ai/keys) page of
  the River Console (`rv_…`). The key is validated against `GET /v1/models` at first use; a key
  River refuses marks the account for sign-in again.
- **Models**: the models your key can use, listed per account from `GET /v1/models`. Context and
  output limits come from [River's docs](https://docs.river.ai/guides/inference-models/); prices
  come from [River's public pricing endpoint](https://console.river.ai/api/public/pricing), the
  same rates billing uses. The documented reasoning efforts
  ([API controls](https://docs.river.ai/guides/inference-controls/)) ride along: DeepSeek-V4.1-Flash
  `none`/`low`/`high`/`max`, Kimi-K3 `none`/`max`, Nemotron `none`/`high`, GLM-5.3-Flash
  `low`/`high`/`max` (reasoning required), Qwen3.8-27B-FP8 `none`/`low`/`medium`/`xhigh`.
- **Requests**: chat completions through `@ai-sdk/openai-compatible` — streaming, reasoning and
  tool calls on every inference model, image input only on the models the docs list for it
  (GLM-5.3 is text-only, and a model the docs don't list yet defaults to text-only). magpie
  translates whatever the agent speaks (Anthropic Messages, Responses, Gemini) into it.
- **Usage**: River meters a prepaid balance per request and publishes no endpoint that reads it,
  so the usage card shows the sign-in state and "Pay as you go" rather than invented numbers;
  spend and balance live in the [River Console](https://console.river.ai/).

## Install

In magpie, open **Plugins → Add** and use the package name or this repository; in a terminal:

```sh
magpie plugin add @magpie-community/opencode-river-auth   # npm
magpie plugin add github:real-jacket/opencode-river-auth  # this repository
magpie plugin login river                                 # paste your rv_… key
magpie provider test river
```

In OpenCode, add the same package under `plugin` and sign in with `opencode auth login`.

## Where your key lives

In OpenCode's `auth.json` and magpie's `plugin-auth.json` (permissions 600), as
`{ "type": "api", "key": "rv_…" }` under the `river` provider — the same file a plain OpenCode
sign-in would write. Requests go only to `api.river.ai`, and the model list prices to
`console.river.ai`'s public pricing endpoint.

## Development

```sh
bun test        # unit tests over the hooks
scripts/try.sh  # (magpie-community/plugins) sandboxed magpie run
```

MIT. Not affiliated with River.
