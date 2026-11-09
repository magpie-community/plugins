# Mistral Vibe

[简体中文](README.zh-CN.md) | English

Mistral Vibe's coding plan in [magpie](https://usemagpie.ai) and
[OpenCode](https://opencode.ai). **Unofficial:** not affiliated with,
endorsed by, or supported by Mistral AI.

One provider, one model group, two wallets. The Vibe key signs in and the
model list is the Vibe plan's own catalog plus DeepSeek; every model is
offered on the Vibe budget and, if a Studio key is given too, on the API
budget as `<id>--api`. The plan's monthly Vibe Code and API budgets are read
into magpie's usage card, `magpie quota`, the quota alert and
`GET /v1/magpie/quotas`.

**Provider id:** `mistral-vibe`

| | |
|---|---|
| API | `https://api.mistral.ai/v1` (`@ai-sdk/openai-compatible`) |
| Sign-in | one credential holding both keys: `vibe=…;api=…` (the Vibe key alone works) |
| Models | the Vibe Code catalog (4 models on 2026-11-08) plus DeepSeek |
| Quota | `GET /v1/billing/budget` → `vibe_budget`, `api_budget`, `reset_at` |

## Sign-in

```sh
magpie plugin login mistral-vibe
```

Paste one line:

```
vibe=<Vibe key>;api=<Studio key>
```

- **Vibe key** — the key the official CLI writes to `~/.vibe/.env` after
  `vibe --setup`, or chat.mistral.ai/code/extensions → **Vibe CLI** card →
  **Advanced** → **Vibe API Key**. Its requests spend the plan's Vibe budget.
- **Studio key** (optional) — console → API › API keys. It adds the same
  models on the API budget.

The Vibe key alone is enough for the Vibe wallet. Neither key expires. JSON
(`{"vibe":"…","api":"…"}`) and two bare keys separated by `;` are accepted
too.

The line holds both keys: treat it like two secrets, and don't paste it into
issues, screenshots or logs.

## Models

On 2026-11-08 the Vibe Code catalog held four models:

| id | label | context | effort levels | vision |
|---|---|---|---|---|
| `mistral-large-4-0` | Mistral Large 4 | 1M | low / medium / high | yes |
| `mistral-medium-latest` | Mistral Medium 3.5 | 262k | none / high | yes |
| `zai-glm-5-3` | GLM 5.3 (Mistral Hosted) | 1M | low / high / max | no |
| `zai-glm-5-3-flash` | GLM 5.3 Flash (Mistral Hosted) | 1M | low / high / max | yes |

DeepSeek is added because the Vibe key serves it (measured), though the CLI's
picker does not list it. With both keys every model is offered twice; the
alias picks the wallet:

| Model id | Name | Spends |
|---|---|---|
| `deepseek-v4-1-flash-1017` | `deepseek-v4-1-flash-1017 (Vibe budget)` | the plan's Vibe budget first, then PAYG |
| `deepseek-v4-1-flash-1017--api` | `deepseek-v4-1-flash-1017 (API budget)` | the API budget / PAYG |

The `--api` suffix is stripped before the request goes upstream; the fetch
picks the key from it. With one key only, only that wallet's ids are listed.

Measured on 2026-11-08 on an Education-plan account (150 USD Vibe Code
budget, 15 USD API budget), same model through magpie's gateway:

| Alias | Request | `vibe_budget` | Charged to the Vibe budget |
|---|---|---|---|
| `…--api` | 248 tokens, 200 | 0.000784 % → 0.000784 % | **$0.000000** |
| plain | 266 tokens, 200 | 0.000784 % → 0.000986 % | **$0.000303** |

If the catalog can't be read, the account's `/v1/models` is used instead,
deduped and filtered: chats only (`capabilities.completion_chat`) and one id
per family (64 entries → 14 for the account above). Families come from
`billing_model_name` and the `aliases` links; the id kept is, in order, the
one billing names, the one whose display name is the id, else `-latest`. A
request naming an aliased id from an older config still works.

### Show the models in magpie

magpie shows only the models ticked for a provider, and a plugin's new ids
start unticked. Tick them once — the app's provider page, or:

```sh
magpie provider models mistral-vibe \
  +mistral-large-4-0 +mistral-large-4-0--api \
  +mistral-medium-latest +mistral-medium-latest--api \
  +zai-glm-5-3 +zai-glm-5-3--api \
  +zai-glm-5-3-flash +zai-glm-5-3-flash--api \
  +deepseek-v4-1-flash-1017 +deepseek-v4-1-flash-1017--api
```

## Quota

`auth.usage` reads the three public endpoints the official CLI reads:
`/v1/billing/budget` (both budgets, their reset), `/v1/billing/subscription`
(plan name) and `console.mistral.ai/api/vibe/whoami` (the key's scope). Both
windows are shown; the key's own budget comes first. A refused key (401)
marks the account expired; a 403 on the budget or a plan without one says so
instead of showing an empty card.

```sh
magpie quota mistral-vibe
```

## Request and reply fixes

Written from the behaviour measured against Mistral's API — the fields it
answers with 422, GLM's 4096-token cap without `max_tokens`, and its typed
content parts. They are not a translation of another implementation.

- aliases are rewritten to the id Mistral serves;
- `max_completion_tokens` → `max_tokens`, `seed` → `random_seed`, `user`
  dropped (Mistral answers those with 422);
- `max_tokens` is filled in for GLM only (131072): without it Mistral caps a
  GLM completion at 4096 tokens, which its thinking alone can spend;
- `reasoning_content` and `index` are stripped from messages a client sends
  back as they came;
- a GLM tool-result turn without an effort gets `reasoning_effort: "high"`,
  which avoids GLM ending such a turn with no visible text;
- `stream_options: {include_usage: true}` is added to a stream that names none;
- a rejected `reasoning_effort` is retried once at the nearest level the model
  lists (nested `reasoning.effort` on `/v1/responses`);
- a 429 is returned as it came: magpie rests the account and falls back on it,
  and `Retry-After` says when to try again;
- GLM's typed content parts (`[{type:"thinking"…},{type:"text"…}]`) become
  `content` (a string) and `reasoning_content`, streamed or buffered, and a
  stream that delta'd tool calls but ends `stop` ends `tool_calls`;
- a rebuilt reply drops the upstream's `content-encoding` and `content-length`,
  which no longer describe its bytes.

One account holds both wallets, so a refusal that rests the account rests the
`--api` ids with it.

## Privacy

The keys stay in magpie's own store (`plugin-auth.json`, or OpenCode's
`auth.json`). The plugin sends no telemetry and reads nothing else; its only
network calls are the three quota reads above and the requests magpie makes
for a model.

## Disclaimer

This is an unofficial community project, not affiliated with, endorsed by or
supported by Mistral AI. It uses the credentials and endpoints the official
Mistral Vibe CLI uses; Mistral's terms still apply, and the plan's limits stay
in force. Mistral's consumer terms forbid sharing an account or its keys, and
creating accounts to get around limits — keep this to your own account. Terms
and endpoints can change at any time; Mistral decides how it enforces its own
terms. The software is provided "as is", without warranty of any kind, and the
authors accept no liability for any loss, including account suspension,
restricted keys or lost subscription fees. Check the current terms before
relying on it.

## License

MIT. See [LICENSE](LICENSE).

## Test

```sh
bun test          # local stand-in for Mistral's endpoints; no network, no key
```
