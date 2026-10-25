# river

River ([river.ai](https://river.ai)) with your API key, in
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). River serves an
OpenAI-compatible inference API at `https://api.river.ai/v1`; this plugin signs every
request with your key, so agents reach its models like any other provider —
multi-account, fallback, quotas and all.

**Provider id:** `river`

## Sign-in

A River API key, created on the [API Keys](https://console.river.ai/keys) page of the
River Console (`rv_…`). The key is stored as `{ "type": "api", "key": "rv_…" }` in
OpenCode's `auth.json` and magpie's `plugin-auth.json` (permissions 600); a key River
refuses marks the account for sign-in again.

## Models

The models your key can use, listed per account from `GET /v1/models`. Context and
output limits come from [River's docs](https://docs.river.ai/guides/inference-models/),
prices from [River's public pricing endpoint](https://console.river.ai/api/public/pricing)
(the same rates billing uses), and the documented reasoning efforts
(`reasoning_effort`) from [API controls](https://docs.river.ai/guides/inference-controls/):
DeepSeek-V4.1-Flash takes `none`/`high`/`max`, GLM-5.3-Flash `low`/`high`/`max`.
Every inference model takes text and image input and streams, reasons and calls tools.

## Usage

River meters a prepaid balance per request and publishes no endpoint that reads it,
so the usage card shows the sign-in state and "Pay as you go" rather than invented
numbers; spend and balance live in the [River Console](https://console.river.ai/).

## Install

```sh
magpie plugin add @magpie-community/opencode-river-auth
magpie plugin login river
magpie provider test river
```

In OpenCode, add the same package under `plugin` and sign in with `opencode auth login`.

## Development

```sh
bun test
bun scripts/check.mjs river
```

MIT. Not affiliated with River.
