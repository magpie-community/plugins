# openscale

OpenScale ([openscale.so](https://openscale.so)) with your API key, in
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). OpenScale serves an
OpenAI-compatible inference API at `https://api.openscale.so/v1`; this plugin signs every
request with your key, so agents reach its models like any other provider — multi-account,
fallback, quotas and all.

**Provider id:** `openscale`

## Sign-in

An OpenScale API key, created at [app.openscale.so](https://app.openscale.so)
(pay-as-you-go keys are `sk-openscale-…`, plan keys `sk-openscale-plan-…`). The key is
stored as `{ "type": "api", "key": "sk-openscale-…" }` in OpenCode's `auth.json` and
magpie's `plugin-auth.json` (permissions 600); a key OpenScale refuses marks the account
for sign-in again.

## Models

The models your key can use, listed per account from `GET /v1/models`. OpenScale's
catalog answer carries each model's context and output limits, input modalities,
per-token prices, tool and reasoning support and its documented `reasoning_effort`
levels, and the plugin builds every model row straight from those fields: limits from
the text modalities, `cost` from the `prompt` / `cached_prompt` / `completion` prices
(per million tokens in USD), image input from `input_modalities`, `tool_call` and
`reasoning` from the documented parameters, and each effort level as a variant agents
can pick. What a key saw when this was written:

| Model | Efforts |
| --- | --- |
| DeepSeek V4.1 Flash (+ 1017 / 0910 pinned, `:fast` serving) | `none` / `low` / `high` / `max` |
| GLM 5.3 Flash (+ 0828 pinned) | `low` / `high` / `max` (reasoning required) |

A pay-as-you-go key may list more models than that, and the live catalog always wins
once it answers. When the catalog cannot be read (network failure, a non-2xx answer),
the previous list is kept; the table above is also bundled as the fallback a fresh
sign-in starts from.

## Usage

OpenScale meters a prepaid balance per request. The quota card reads it from
`GET /api/cli/balance` — undocumented; it is the endpoint OpenScale's own CLI
calls (openscale-cli), and it works with a key alone. `magpie quota` shows the
balance, the last 24 hours' spend and the plan (pay-as-you-go or OpenScale
Unlimited).
