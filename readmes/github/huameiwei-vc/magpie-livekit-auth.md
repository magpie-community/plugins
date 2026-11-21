# magpie-livekit-auth

Use **LiveKit Inference** as a provider in [magpie](https://usemagpie.ai) (and OpenCode).

One LiveKit API key gives you DeepSeek, GPT, Gemini, Kimi and Grok in Claude Code, Codex,
OpenCode and every other agent magpie connects — no account with each model vendor.

```
magpie plugin add huameiwei-vc/magpie-livekit-auth
magpie plugin login livekit
magpie provider test livekit
```

Then pick `livekit/deepseek-v4.1-flash` (or any model below) in your agent.

---

## What it signs in to

A LiveKit project, with an **API Key** and **API Secret**.

LiveKit's key/secret are not a bearer token. Every request signs a short-lived JWT
(HS256, `{ inference: { perform: true } }`, 10 minutes) with your secret, and sends it as
`Authorization: Bearer …`. The plugin does that itself — no dependencies, using WebCrypto.

Where to get them: [cloud.livekit.io](https://cloud.livekit.io) → your project → **Settings → Keys** → **Create**.
The secret is shown **once**, when the key is created. Copy both then.

Where they are stored: magpie's own `plugin-auth.json` (mode 600), like every other plugin's
sign-in. This plugin never writes them anywhere else and never logs them.

## Models

Confirmed working against `https://agent-gateway.livekit.cloud/v1` on **2026-11-21**.
LiveKit retires models regularly — if one stops answering, check
[docs.livekit.io/agents/models](https://docs.livekit.io/agents/models) and open an issue.

| Model in magpie | What it is | Context | Max output | Thinking levels |
|---|---|---|---|---|
| `livekit/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1,048,576 | 384,000 | low / medium / high |
| `livekit/gpt-6-luna` | GPT-6 Luna | 1,050,000 | 128,000 | minimal / low / medium / high |
| `livekit/gemini-3.8-flash` | Gemini 3.8 Flash | 1,048,576 | 65,536 | low / medium / high |
| `livekit/kimi-k2.6` | Kimi K2.6 | 262,144 | 262,144 | low / medium / high |
| `livekit/grok-4.7` | Grok 4.7 | 524,288 | 131,072 | low / medium / high |

All five support tool calling, which is what coding agents rely on.

Two of them need care, and the plugin already handles both:

- **Kimi K2.6** spends its whole output budget on thinking when the budget is small,
  and then says nothing. The plugin raises any Kimi request below 8,000 tokens to 8,000.
- **DeepSeek V4 Pro was removed.** LiveKit silently served it with Gemma 4 31B, twice in a
  row on 2026-11-21, so the entry is gone rather than showing a model that is not itself.

## Thinking content

Whether a model's reasoning text comes back depends on the model, not on the plugin:

| Model | Thinking text returned? | Field |
|---|---|---|
| `deepseek-v4.1-flash` | **yes** | `reasoning_content` |
| `kimi-k2.6` | **yes** | `reasoning` + `reasoning_details` |
| `gpt-6-luna` | no — only `reasoning_tokens` in usage | — |
| `gemini-3.8-flash` | no — only `reasoning_tokens` in usage | — |
| `grok-4.7` | no — only `reasoning_tokens` in usage | — |

The gateway passes both fields through, on streaming and non-streaming requests, and magpie
understands both — so a client that renders thinking will show it for the first three.
The other three still think (you can see the tokens in usage), they just do not return the text.

## The model can silently become a different model

This one matters. LiveKit falls back to another model when the one you asked for is not
available, and it does **not** fail the request. The response says so in a header:

```
X-Livekit-Inference-Llm-Model-Fallback: google/gemma-4-31b-it
```

Asked for `deepseek-v4-pro` on 2026-11-21 and this is what came back — Gemma 4 31B
answering in DeepSeek's place. That is why it can feel "not really DeepSeek", and why that
model was removed from this plugin.

The plugin does two things about it:

- logs a warning to magpie's log: `[livekit] … 实际由 … 服务（LiveKit 自动回退）`
- keeps the last one for 30 minutes and shows it in `magpie quota livekit` as a
  **回退提醒** row

If a model falls back often, stop using it. That is exactly what happened to
`deepseek-v4-pro`, and why it is no longer offered here.

## Remaining credits: what can and cannot be shown

There is no API for the `$2.50` balance. `/v1/models` returns `{}`, and the LiveKit
Cloud API has no usage or credits resource. The plugin asks anyway, on every quota refresh
(one `max_completion_tokens: 1` request, about ten tokens):

- **if** LiveKit ever starts sending `X-Livekit-Inference-Credits-Limit` / `-Used`,
  `magpie quota livekit` shows a real `used / limit` window with a percentage, with no
  change needed here
- **today** it shows `LiveKit 不公开余额，控制台查看`, the real rate limits
  (`RPM` / `TPM`), and the last fallback or quota warning it saw

So: rate limits — yes; remaining credits — only in the console.

## Automatic model discovery

`magpie provider models` asks `/v1/models` first. If it ever lists models, the plugin
uses that list: models that disappeared are dropped, new ones are added with conservative
limits (128k context, 32k output) until their real numbers are known. While the listing is
empty — which is the case today — the static table above is used unchanged.

## Read this before you use it for real work

**The $2.50 is a trial allowance, not a plan.** LiveKit's Build plan includes
$2.50 of inference credits per month — roughly 50 minutes of voice, or a few hours of
chat. When it runs out the gateway answers `429`.

**Five concurrent requests.** That is the Build plan's inference limit. A coding agent
often runs several requests at once (sub-agents, tool loops, title generation), so heavy
sessions will queue or fail with `429`. The plugin declares `maxConcurrency: 5` so magpie
can plan around it.

**This is not an official model-vendor API.** LiveKit resells inference on infrastructure
it does not run (its docs name Baseten and Vercel as the hosts). The endpoint is stable
enough for development and personal use; treat it as a convenience, not as the backbone
of a product. For production, use DeepSeek's, OpenAI's or Google's own key.

**Do not pin a provider.** LiveKit accepts `X-LiveKit-Inference-Provider` to force an
upstream, but it fails the whole request instead of falling back, and most models are only
served by one host. This plugin does not send it.

## What the plugin does with your request

- Signs a fresh token when the cached one is within a minute of expiring.
- Forwards everything else as-is, including `tools`, `reasoning_effort` and streaming.
- Renames `max_tokens` to `max_completion_tokens` when a client sends the old name
  (the gateway rejects it for `openai/*` models; magpie normally does this itself).
- Raises Kimi's output budget to 8,000 when it is smaller.
- Passes gateway errors through untouched, so magpie can fail over and mark a sign-in
  only when it really is one (401).

## Debugging

Set `LIVEKIT_DEBUG_BODY=1` before starting magpie to have the plugin log a redacted
summary of each request — path, model, which fields arrived, and the thinking level.
It never logs messages, prompts or keys.

```
LIVEKIT_DEBUG_BODY=1 magpie serve
```

Then read `magpie log -f` (or the log file) for lines starting with `plugin: [livekit]`.

## Troubleshooting

| What you see | What it means |
|---|---|
| `401 invalid authorization token` | Wrong key/secret, or the key was deleted. `magpie plugin login livekit` again. |
| `404 Error getting model definition` | The model id is no longer served. Check the models list above. |
| `429` | Credits used up, or more than 5 requests at once. |
| Empty reply from Kimi | Output budget under 8,000 — the plugin fixes this, so please report it if you still see it. |
| `400 Unsupported parameter: 'max_tokens'` | A client sent the old field name on an `openai/*` model. The plugin converts it; report if it still happens. |

## Test it

```
bun test
```

Covers token signing (shape, TTL, signature length), request rewriting, the model table,
and the plugin hooks — including that the loader overrides a stale `Authorization` header.

## License

MIT.
