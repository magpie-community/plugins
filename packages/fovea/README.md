# @magpie-community/middleware-fovea

The eye's focal centre, for an agent's history — as [magpie](https://usemagpie.ai) gateway middleware. The recent window a request works in stays sharp; the history around it, like peripheral vision, stays present but carries only its outline: old tool results and long old texts are cut to their head and tail, and images sent turns ago give way to a one-line note. And on a saccade — the eye jumping to a new target — a new topic's request does not carry the old context at all. The agent keeps its whole history, as it should; it just stops paying to re-read every old file and command output on every turn.

A coding agent that reads files and runs commands can carry 200k tokens of history, most of it tool output from many turns back. That cost comes back on every request — and it is the part with the shortest useful life. This middleware shortens it at the gateway, before it reaches the provider, whatever provider serves the request.

All three request shapes are read in their own way — Chat (`role:"tool"`), Anthropic (`tool_result` blocks) and the Responses API (`function_call_output` items) — and a body in none of them passes untouched.

Nothing is dropped:

- message count and order stay as sent; an old tool result is shortened, not removed, so every `tool_call` still has its answer, in both Chat (`role:"tool"`) and Anthropic (`tool_result`) shapes
- the system prompt, the first user message (the task the history serves) and the last `keep_recent` messages are never touched
- tool calls, ids and thinking blocks are never touched
- content already carrying the marker is left alone, so a history the agent sends back each turn is cut once, not again
- content matching a `protect` pattern (a diff, a key block) is left whole
- under `threshold` the request passes as it came, byte for byte

The request's size is measured by walking its strings, not by serialising the whole body — on a 5MB request that is the difference between reading it and allocating another 5MB on the request path.

On a saccade the old task message collapses with the rest — it was the previous topic's, and the new question does not serve it. Short old texts (under ~160 chars) stay: they cost nothing and keep the flow readable. Tool pairing survives the same way as always: an old tool result becomes a note, never a removal, so every `tool_call` still has its answer.

Replies are never touched: what the agent keeps from a reply is the agent's to keep.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-fovea`. Options live under **Plugins › Installed › Options**, or with `magpie plugin options fovea '<json>'`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `threshold` | `96000` | Chars of request the middleware acts above (~24k tokens). `0` acts on every request. |
| `keep_recent` | `12` | Messages at the end kept whole. |
| `keep_recent_tokens` | `16000` | The same window as a token budget. The larger of the two windows is kept, so a few huge recent messages are not cut for being few. `0` turns the budget off. |
| `tool_head` / `tool_tail` | `600` / `300` | What an old tool result keeps of its start and end. |
| `text_head` / `text_tail` | `1200` / `400` | What an old text message keeps. |
| `drop_old_images` | `true` | Images older than the window become `[fovea: old image omitted]`. |
| `protect` | `[]` | Regexes whose matches stay whole — `["^diff --git ", "BEGIN .*PRIVATE KEY"]` for text that is only useful verbatim. |

A cut carries a marker in place of what was taken:

```
…600 chars…
[fovea: 48213 chars of old tool output omitted]
…300 chars…
```

so both the agent and its human can see what happened, and the middleware can recognise its own work next turn.

## When not to use it

The recent window is kept by message count, not tokens: a single huge recent message stays whole. What this middleware does is mechanical — it cannot tell which old detail matters, only where the head and the tail are; if an agent's work turns on re-reading an old tool output verbatim, raise `tool_head`/`tool_tail` or turn the middleware off for that run. Shortened history also means a provider's prompt cache for the shortened prefix no longer matches — it settles again a turn later, once the same old messages come back already cut.

## Try it locally (no model call)

The preview reads a local request JSON and prints which messages change. It does not send the request or print message bodies:

```sh
bun packages/fovea/preview.mjs --demo
bun packages/fovea/preview.mjs /path/to/request.json
bun packages/fovea/preview.mjs /path/to/request.json '{"keep_recent":4,"protect":["^diff --git "]}'
```

The numbers are estimated with the middleware's size walk (`chars / 4` for tokens), not a provider tokenizer. On the demo history: about 190,851 → 55,439 estimated tokens. For live usage, compare the provider's `prompt_tokens` and request latency with the middleware on and off; the separate 0.1.0 experiment used 163,143 → 42,358 prompt tokens and a median 7.1s → 2.5s. Results vary by history shape and provider cache.

## Mark and visual

`brand/assets/mark.svg` is a transparent 1:1 monochrome mark. Full lines above and below represent preserved context; the three dots represent a visible omission. Light and dark SVG variants, color provenance, an offline review page and 32px browser screenshots are in `brand/`. The ink color `#161616` was sampled from magpie's existing icon; it is a material measurement, not an official brand token.
