# D.AI for magpie / OpenCode

Use your [D.AI](https://dai.itbug.shop) models — GPT-6, Claude Opus 5.5, Grok 4.7,
DeepSeek V4.1, GLM 5.3, Gemini 3.8 — from any agent that speaks through
[magpie](https://usemagpie.ai) or OpenCode.

One `ddsk_…` API key is one account, and magpie keeps several.

## Add it

```sh
magpie plugin add mdddj/d-ai-magpie       # from GitHub (the unofficial list installs this)
magpie plugin add @d-ai/magpie            # from npm, once published
magpie plugin login dai                   # asks for the API key
magpie provider test dai                  # one tiny call per API
```

Then pick a model anywhere magpie does: `dai/claude-opus-5-5`,
`dai/gpt-6-astra`, `dai/deepseek-v4.1-flash`, …

The key comes from the D.AI console (`/#/apikeys`). Custom deployments can point
at another host with `magpie plugin options dai '{"baseUrl":"https://dai.example"}'`
or `DAI_BASE_URL`.

`DAI_API_KEY=ddsk_… ./e2e.sh` runs the same checks in a throwaway `HOME`, so it
never touches the magpie you actually use. Add `--live` to make one real call
on each API.

## What it exposes

15 token-metered chat models, in two APIs:

| API | Models | Path |
| --- | --- | --- |
| OpenAI chat completions | `deepseek-v4.1-flash`, `gemini-3.8-flash`, `glm-5.3-flash`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-sol`, `grok-4.6`, `grok-4.7` | `/v1/chat/completions` |
| Anthropic Messages | `claude-fable-5`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5` | `/v1/messages` |

The model list and the prices come from D.AI's public catalog on every start
(`GET /api/system/public/capability-docs`), narrowed to the models that key may
call (`GET /v1/models`), so a model you are not entitled to never shows up and a
new model appears without a plugin update. A built-in list is used when D.AI
cannot be reached while the provider is first configured.

Every model reports its context window, its output cap, its USD/1M-token prices
and its thinking levels. Image input is marked for the families D.AI serves with
vision (GPT-5/6, Claude, Gemini, Grok, DeepSeek, GLM).

## Usage

`magpie quota` shows the account behind the key: the wallet balance, the tier
and its cycle, how much of the balance this key alone may spend, and how many
calls it made today. That comes from `GET /api/ai/account`, an endpoint
authenticated by the `ddsk_` key itself.

A D.AI key has no plan window — it spends the account's shared wallet — so the
card reads as a balance, not a quota window. Two keys of one account show the
same balance but their own reservations and call counts.

## Notes

- Only chat models. D.AI's image, video, music and ASR models are separate
  capabilities with their own endpoints; agents here want a chat completion.
- The usage card needs `GET /api/ai/account` on the D.AI deployment. Against an
  older one (404) the plugin falls back to the key's call log and shows call
  counts instead of a balance.
- The plugin never rewrites request bodies. Thinking levels are offered as
  model variants, and the gateway passes `reasoning_effort` through.
- Requests go out with `Authorization: Bearer <key>` plus `x-api-key`, so
  either D.AI route works.
