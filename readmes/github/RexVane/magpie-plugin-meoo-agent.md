# magpie-plugin-meoo-agent

[English](README.md) · [简体中文](README.zh-CN.md)

Bring [Meoo (秒悟)](https://meoo.com)'s **app-building Agent** into magpie as a provider.

## Why this exists

Meoo's Open API has **no chat completions endpoint**. It only understands three things:

```
create project  →  start an Agent Run  →  subscribe to an SSE event stream
```

Clients, on the other hand, speak the OpenAI protocol. Something has to translate.

Following magpie's plugin contract (the same approach
[`@magpie-community/opencode-commandcode-auth`](https://github.com/magpie-community/plugins) takes),
this plugin does the translation inside the **custom `fetch`** returned by `auth.loader()`:

- rewrites incoming `POST /chat/completions` into `POST /projects/{id}/agent/runs`
- reassembles `message.delta` / `message.snapshot` from the SSE stream back into a chat completion
- supports both streaming (`stream: true`) and non-streaming

**No port, no sidecar process** — the whole translation runs inside magpie.

## Install

Discovered on GitHub via the [`magpie-plugin`](https://github.com/topics/magpie-plugin) topic.
Inside magpie, open the **unofficial plugins (GitHub)** list and install it, or add it manually:

```bash
cd ~/.config/magpie/plugins
bun add github:RexVane/magpie-plugin-meoo-agent
```

then add to `~/.config/magpie/plugins.json`:

```json
{ "spec": "magpie-plugin-meoo-agent" }
```

**Provider id:** `meoo-agent` · **Auth:** `API key` — create a `meoo_ak_...` key at
[meoo.com](https://meoo.com) → 设置 → API 密钥.

## Speed tiers as model variants

Meoo's Run endpoint takes a `speed_tier` field (`fast` = lowest latency /
`standard` = balanced / `deep` = more reasoning, slower and costlier).
This plugin exposes it as **model variants**, so you pick it from the model dropdown
instead of configuring an environment variable:

```
qwen3.8-flash@fast        lowest latency
qwen3.8-flash@standard    balanced
qwen3.8-flash@deep        deepest reasoning
```

Every upstream model gets all three, so the model count is `upstream × 3`
(14 × 3 = **42** in practice).

The plugin strips the `@tier` suffix before calling Meoo, and keeps the full
variant name in the response's `model` field.

A model id without a suffix falls back to the default tier
(`fast`, overridable with `MEOO_SPEED_TIER`).

## Environment variables

All optional. Read when the plugin loads, i.e. **before magpie starts**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | **Fallback only** — used when a model id carries no `@tier` |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Meoo project the Agent works in; reused when it already exists |
| `MEOO_TIMEOUT_MS` | `600000` | Per-Run timeout in milliseconds |
| `MEOO_AUTO_ANSWER` | see source | Auto-reply when the Agent asks a question. Empty string = fail instead of auto-answering |
| `MEOO_VERBOSE` | off | `1` turns on plugin logging |

## Known limitations

1. **It is not a model — it is an app-building Agent.** It carries project context,
   calls tools, and writes files into that Meoo project. It will usually answer a
   general question fine, but it is not a general-purpose LLM.
2. **Slow.** One Run takes minutes (`deep` longer). Ordinary chat clients may time out.
3. **Billed in credits, not tokens.** The real cost is `usage.meoo_credits_used`;
   `prompt_tokens` / `completion_tokens` are always 0 because Meoo's protocol
   does not report them.
4. **No `temperature` / `max_tokens` / `tools` / function calling.** Meoo's protocol
   has no such fields, they are silently ignored — hence `tool_call` is reported as `false`.
5. **No multi-turn conversation mapping.** Each request is an independent Run.
6. **Streaming may occasionally drop a fragment.** `message.snapshot` has been observed
   arriving out of sync with the accumulated deltas; the plugin skips that frame's
   increment (non-streaming is unaffected — the final text follows the snapshot).
   Use `stream: false` if you want to be safe.

## Authorization note

Meoo's own documentation states that a user API key "must not be used as a way to
bypass team system integration or the integration-tier entitlement package".
This plugin is a personal-use adapter. Please do not run it as a service for others.

## License

MIT
