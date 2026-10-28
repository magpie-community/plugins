# @magpie-community/middleware-context-slim

An agent's own history, thinned where it was only ever read once — as [magpie](https://usemagpie.ai) gateway middleware. Old tool results and long old texts are cut to their head and tail, and images sent turns ago give way to a one-line note. The agent keeps its whole history, as it should; it just stops paying to re-read every old file and command output on every turn.

A coding agent that reads files and runs commands can carry 200k tokens of history, most of it tool output from many turns back. That cost comes back on every request — and it is the part with the shortest useful life. This middleware shortens it at the gateway, before it reaches the provider, whatever provider serves the request.

Nothing is dropped:

- message count and order stay as sent; an old tool result is shortened, not removed, so every `tool_call` still has its answer, in both Chat (`role:"tool"`) and Anthropic (`tool_result`) shapes
- the system prompt, the first user message (the task the history serves) and the last `keep_recent` messages are never touched
- tool calls, ids and thinking blocks are never touched
- content already carrying the marker is left alone, so a history the agent sends back each turn is cut once, not again
- under `threshold` the request passes as it came, byte for byte

Replies are never touched: what the agent keeps from a reply is the agent's to keep.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-context-slim`. Options live under **Plugins › Installed › Options**, or with `magpie plugin options context-slim '<json>'`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `threshold` | `96000` | Chars of request JSON the middleware acts above (~24k tokens). `0` acts on every request above the window. |
| `keep_recent` | `12` | Messages at the end kept whole. |
| `tool_head` / `tool_tail` | `600` / `300` | What an old tool result keeps of its start and end. |
| `text_head` / `text_tail` | `1200` / `400` | What an old text message keeps. |
| `drop_old_images` | `true` | Images older than the window become `[context-slim: old image omitted]`. |

A cut carries a marker in place of what was taken:

```
…600 chars…
[context-slim: 48213 chars of old tool output omitted]
…300 chars…
```

so both the agent and its human can see what happened, and the middleware can recognise its own work next turn.

## When not to use it

The recent window is kept by message count, not tokens: a single huge recent message stays whole. What this middleware does is mechanical — it cannot tell which old detail matters, only where the head and the tail are; if an agent's work turns on re-reading an old tool output verbatim, raise `tool_head`/`tool_tail` or turn the middleware off for that run. Shortened history also means a provider's prompt cache for the shortened prefix no longer matches — it settles again a turn later, once the same old messages come back already cut.
