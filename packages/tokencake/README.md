# TokenCake

TokenCake's coding-plan subscription in [OpenCode](https://opencode.ai) and
[magpie](https://usemagpie.ai). TokenCake's gateway is OpenAI-compatible at
`https://api.test.tokenca.ke/v1`; this plugin signs every request with your
API key, so agents reach its models like any other provider.

**Provider id:** `tokencake`

The package icon is TokenCake's dark logo (`https://bake.test.tokenca.ke/logo-icon-dark.png`), as its site declares it.

## Install

```sh
magpie plugin add @magpie-community/opencode-tokencake-auth
magpie plugin login tokencake
```

In OpenCode, add the same package under `plugin` in `opencode.json` and sign
in with `opencode auth login`.

## Sign in

A TokenCake API key (`sk-…`). The form checks the shape TokenCake's own
quick-connect page checks, `^sk-[\w-]{16,256}$`, as a hint; the key is never
echoed back. It is stored as `{ "type": "api", "key": "sk-…" }` in OpenCode's
`auth.json` and magpie's `plugin-auth.json`.

## Models

The models your key gets, read per account from `GET https://api.test.tokenca.ke/v1/models`
with `Authorization: Bearer sk-…`. The catalog is served as it comes: ids keep
their `/` (`z-ai/glm-5.3`), and a display name is used only when the entry has
one. No context window, price, image input or tool support is added, because
the endpoint states none of them here; the one capability added is reasoning,
below, and only on the ids models.dev has it for.

When the catalog can't be read — no sign-in, a network failure, a non-2xx
answer, a body that isn't `{"data": [{"id": …}]}`, or an empty list — the
provider keeps its list: the three ids TokenCake's public client ships
(`z-ai/glm-5.3`, `z-ai/glm-5.3-flash`,
`deepseek/deepseek-v4.1-flash-1017`). A catalog read successfully replaces it
whole; the fallback is never mixed into it.

The `200` shape from `/v1/models` is expected to be the OpenAI-compatible
`{"data": [{"id": …}]}` and **was not verified live**. An answer that doesn't
fit is treated as unreadable, not guessed at.

## Reasoning levels

`z-ai/glm-5.3` and `z-ai/glm-5.3-flash` are offered with reasoning on and three
efforts: `low`, `high` and `max`. Those come from models.dev's vendor metadata
for Z.ai / Zhipu (the `zai` and `zhipuai` providers, where both ids are
`reasoning: true` and their effort values are exactly `low`, `high` and `max`),
not from TokenCake's endpoints. There is no "none": GLM keeps reasoning on.

`deepseek/deepseek-v4.1-flash-1017` gets the same three levels. models.dev has
no entry for that exact id; what it does state is the DeepSeek v4 family —
`deepseek-v4-flash` and `deepseek-v4-pro` are both `reasoning: true` with
efforts exactly `low`, `high` and `max`. This plugin applies that family shape
to the id TokenCake serves, as asked. It is the family's shape, not a record
for this exact id.

A level is a variant, `{ "reasoningEffort": "low" }` — the options OpenCode
merges into the request, which magpie's gateway sends as `reasoning_effort`.
Picking no level adds nothing, so a request is exactly what it was before.
Whether TokenCake's gateway forwards `reasoning_effort` upstream **was not
tested**; if a level changes nothing, it doesn't.

Every other id is listed with its name alone — no reasoning, no levels, whether
it comes from the fallback list or from a catalog read.

## Requests

Models default to `@ai-sdk/openai-compatible`, so a request is
`POST https://api.test.tokenca.ke/v1/chat/completions` signed
`Authorization: Bearer sk-…`. The plugin injects that header itself, keeps the
SDK's headers and streams, and passes the gateway's answer through untouched.
Redirects are refused so the key can't be sent to another origin. Chat
completions weren't exercised live; the Anthropic Messages API is not used.

## Usage

`GET https://api.test.tokenca.ke/v1/codeplan/usage` with the same key returns
the plan and its windows:

```json
{
  "plan": { "name": "…" },
  "unit": "credits",
  "windows": [
    { "window": "5h", "used": 10, "limit": 100, "remaining": 90, "reset_at": "2026-11-14T12:00:00Z" }
  ]
}
```

The card shows `5h`, `7d`, `14d` and `monthly` in credits. The percentage is
`100 × (limit − remaining) / limit`, taken from `remaining` — the number
TokenCake's own dashboard shows. `5h` gets a 5-hour span, `7d` and `14d`
theirs; `monthly` gets none, as the endpoint states no length for it.
`reset_at` is shown when it is an ISO time and left out when null. A window
whose quotas aren't whole sane numbers, or a window name this plugin doesn't
know, is skipped; no window is invented.

No sign-in gives an error; a `401` marks the account for sign-in again; any
other failure gives the HTTP status or a fixed message. A remote response body
is never shown.

The `200` shape comes from TokenCake's public quick-connect front end
(`quick-connect-D2jDaszL.js`), **not from a live authenticated read** — expect
the body above, and report a different one rather than trusting this page.

## Development

```sh
bun test
bun scripts/check.mjs tokencake
```

MIT. Not affiliated with TokenCake.
