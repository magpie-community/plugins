# @yelo/magpie-slowdown

> 🚦 A magpie gateway middleware that lowers how often an Agent client receives a streamed response.

English | [中文](./README.zh-CN.md)

magpie-slowdown merges the frames inside a window into one big frame. The client gets the same text at the same tokens per second (TPS), but it receives fewer API response events. This helps you debug how an Agent client behaves at different output rates.

It supports three response protocols: Chat Completions, Responses and Gemini. *It does not support Anthropic, whose stream passes through at full rate.*

## Install

```sh
magpie plugin add @yelo/magpie-slowdown
magpie plugin options @yelo/magpie-slowdown '{"enabled":true,"intervalMs":50}'
```

The change takes effect in about one second. Magpie does not need a restart.

You can also disable it by hand with magpie's `plugin off`:

```sh
magpie plugin off @yelo/magpie-slowdown
```

## Options

| Field           | Type | Default | Description |
| --------------- | ---- | ------- | ----------- |
| `enabled`       | bool | `false` | Master switch. When `false`, every event passes through unchanged. |
| `intervalMs`    | int  | `50`    | Merge window in milliseconds. At most one merged frame goes out per window. |
| `maxBufferSize` | int  | `1000`  | Maximum number of frames held in the pending window. Reaching it flushes early. Text is still preserved. |

## Why it is not per-frame throttling

magpie-slowdown lowers **how often the client receives events**. It does not lower TPS, and it does not change the total response time. Data piles up in a buffer during each window. At the start of the next window, the middleware merges everything the buffer holds. That lowers the number of events the downstream side receives per second.

The current Magpie Plugin API does not let a middleware emit a new event downstream. So magpie-slowdown **cannot extend the total response time**:

| Platform fact | Consequence |
| ------------- | ----------- |
| `onEvent` may return only one event, an object, `null` (drop) or `undefined` (unchanged) | a single upstream event cannot produce several downstream events |
| An array return becomes the JSON of a single frame (`data: [{…},{…}]`) | it does not expand, and it breaks clients |
| moejs has no `setTimeout` or `setInterval`, and `ctx` exposes no write, flush or delay handle | an event cannot go out later |
| `onEvent` has a wait limit of 50 ms. After that, magpie sends the event unchanged | blocking the process inside the hook gains nothing |
| The response ends when the upstream ends | the provider sets the total duration |

—— The only thing the middleware controls today is the **frame count**.

## Merge rules

An event that carries text and arrives within `intervalMs` goes into the buffer. At the next window boundary, the buffered events go out as one merged frame. The client receives fewer frames with exactly the same text.

- The first text frame of a response goes out immediately. First-token latency does not change.
- Frames that carry no text (`role`, usage, keep-alives) and no tool call pass straight through. Pure tool_call deltas pass by reference, unchanged.
- A frame that carries text and tool calls merges like a normal text frame, and its `tool_calls` survive. MiniMax-M3 sends these frames at the thinking→tool boundary, as tested. Merged frames group tool calls by `index`: the first-seen identity wins, and `arguments` join in arrival order. A buffered tool_call frame holds back later fragments, so the arguments JSON never reorders. Gemini non-text parts (`functionCall`, …) and Responses non-text delta parts survive the same way.
- The middleware tracks Responses text per `item_id`. A merged `output_text.done` carries only the text of its own item. The middleware never treats `function_call_arguments.delta` as text.
- The middleware never drops the terminator frame. Anything not yet sent (text, tool_calls, parts) goes out with it. So the tail of a response cannot vanish.
- If the hook throws, the original event goes out unchanged.
- `enabled: false` is the default. Every event then goes out unchanged, with the same object reference, so magpie's own serialization does not change.

**The middleware never merges Anthropic frames. The whole Anthropic stream passes through unchanged.**

> The tail of an Anthropic stream has no safe landing point, so the middleware touches none of its frames. See [which protocols support merging](#which-protocols-support-merging) for the detail.

## Supported response protocols

The middleware reads the protocol from the **event itself**, not from `ctx.protocol`. `ctx.protocol` names the API of the client. When the provider serves the client protocol, magpie relays the upstream bytes unchanged. So a chat client can read Anthropic-protocol bytes while `ctx.protocol` says something else. Events with an unrecognized protocol, and every Anthropic frame, pass through unchanged.

| Protocol | Recognised by | Text field | Terminator | Where a pending tail goes |
| -------- | ------------- | ---------- | ---------- | ------------------------- |
| OpenAI Chat Completions | `choices[]` | `choices[0].delta.content` | `choices[].finish_reason` is set | into the terminator frame itself (the last chunk may carry both content and `finish_reason`) |
| OpenAI Responses | `type: "response.…"` | `delta` (string, or parts array) | `response.completed` / `response.incomplete` | into `response.output_text.done`, whose `text` holds the full text so far |
| Gemini | `candidates[]` | `candidates[0].content.parts[0].text` | `candidates[].finishReason` is set | into the terminator candidate |
| Anthropic Messages | `type: "message_…"` / `"content_block_…"` | — | — | **none: always passed through, never merged** |

Magpie relays `data: [DONE]` unchanged. `onEvent` never sees it.

### Which protocols support merging

`chat`, `responses` and `gemini` responses support merging. Each of these protocols has an explicit terminator frame, so the buffered data of the last window can go out with it.

Anthropic responses do not support merging. The Anthropic terminator frame cannot carry text. A merge would lose the buffered data of the last window.

## Development

The toolchain is pinned by `mise.toml` (Node 24 and Yarn 4), and `package.json`
declares the same Yarn version in `packageManager` for Corepack.

```sh
mise install
yarn
```

Unit tests:

```sh
yarn test
```

Use the [Mock Provider](tools/mock-provider/README.md) for integration tests.

```sh
node tools/mock-provider/check-stream.mjs --model mock-stream/mock-fast --expect 'AxxxxxxZ'
```

CI installs the same pinned toolchain from `mise.toml` with `jdx/mise-action`,
then runs `yarn install --immutable && yarn test`.

## License

Apache-2.0
