# @magpie-community/middleware-empty-reply

Some chat models return reasoning and no text. magpie passes that on as a
finished reply: `end_turn` for Anthropic clients, `response.completed` for
Responses. Claude Code takes the turn as done and stops; Codex ends the turn
with no output (yetone/magpie#3358).

This middleware drops the end of such a reply. The client sees the stream
break before the answer and retries.

```sh
magpie plugin add @magpie-community/middleware-empty-reply
```

No options.

## What gets dropped

| Protocol | Dropped | Counts as an answer |
| --- | --- | --- |
| Anthropic | `message_delta` with `end_turn`, then `message_stop` | text, refusal, tool call |
| Responses | `response.completed` | output_text, refusal, function call |

Reasoning never counts as an answer. `max_tokens` and `refusal` stops are
left alone, because the model meant to stop.

Whole (non-streamed) replies become an error instead: an Anthropic error
body, or a Responses response with `status: "failed"`.

Chat clients aren't covered. Their stream has no error event, and the gateway
fix is the right place for that anyway.

## Routing

Middleware runs after routing, so it can't ask the next group member itself.
It only makes the client retry.

- `rotate`: the retry hits another member. This is the setup that works.
- `ordered`: the retry hits the same member, fails again, and the client gives
  up with a visible error. Still better than a silent stop.

Once your magpie build has the gateway empty-reply fix from #3358, you don't
need this plugin.

## Tested

Against a Chat upstream that sends reasoning then `stop`, with real clients:

- Claude Code 2.1.319, `ordered`: three retries, then `API Error: Connection
  lost before a response was produced. Try again.`
- Claude Code 2.1.319, `rotate`: the retry reached a healthy member and the
  turn completed.
- codex-cli 0.167.0, `ordered`: `Reconnecting... 1/5` to `5/5`, then `stream
  disconnected before completion`.
- codex-cli 0.167.0, `rotate`: one reconnect, then a normal answer.
- Normal replies and tool calls pass unchanged.

中文：有些 Chat 上游只返回 reasoning、正文为空，翻译后却以 `end_turn` 或
`response.completed` 结束，Claude Code / Codex 会当成回答完毕直接停下。这个中间件
丢掉这种回复的结尾，让客户端重试；配合 `rotate` 路由会落到组里的另一个成员。
它不是 #3358 的正解，网关自身的空回复检查才是。
