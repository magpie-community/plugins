# @magpie-community/middleware-think-tags

A model's thinking, where its reply's text is, as [magpie](https://usemagpie.ai) gateway middleware. It either takes thinking out of the text, or puts it in (New API's `thinking_to_content`).

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-think-tags`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options think-tags '<json>'`.

## Options

```json
{ "mode": "strip" }
```

**`strip`** (the default). Some models (open reasoning models served by vLLM, Ollama and many relays) write their thinking into the reply as `<think>…</think>`. This mode takes that block out, so an agent doesn't keep it in its history and send it back every turn.

- Only a block at the start of the text is taken out. A `<think>` the model writes later, in code for example, stays.
- A `</think>` inside the block in Markdown code (`` `</think>` ``, or a fenced block) is part of the thinking, an example written out, not its end.
- A tag split across streamed chunks is still found.
- It works on Anthropic, Chat and Responses replies, streamed or whole.

**`to_content`**. A Chat reply's `reasoning_content` (or `reasoning`) is put into its text as `<think>…</think>`, for a client that shows only the text.

- This mode works on Chat replies only. An Anthropic thinking block carries a signature, and turned into text it would fail the next turn.
- It changes what the agent keeps and sends back, so it suits a chat client better than a coding agent.

中文：`strip` 去掉回复开头模型写出的 `<think>…</think>`；`to_content` 把 Chat 回复的 reasoning_content 放进正文（New API 的 thinking_to_content）。
