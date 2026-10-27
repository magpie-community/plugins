# @magpie-community/middleware-history-trim

A request's history, sent smaller, as [magpie](https://usemagpie.ai) gateway middleware. It folds a run of blank lines, drops a system prompt written twice and a message repeated right after itself, and cuts a past tool result longer than `maxToolLength` at a word boundary.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-history-trim`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options history-trim '<json>'`.

## Options

```json
{ "maxToolLength": 2000 }
```

**`maxToolLength`** (the default, 2000). A tool result from an earlier turn longer than this many characters is cut to it, at the nearest word boundary within 80 characters, and ends with `\n...[truncated]`. A cut never splits an emoji or another surrogate pair in half.

- The turn being sent now is never cut, and never rewritten by any of the four steps. A message at or after the last assistant message is the history the model has not read yet, so it goes out whole — a patch line, a Markdown hard line break or a trailing tab in it survives; a history with no assistant message in it is left whole too.
- Both shapes are cut: a Chat `role: "tool"` message whose content is a string, and an Anthropic `tool_result` block inside a content array, whether its content is a string or an array of text parts.
- A number below 256 or above 1000000 is not a length anyone means, and falls back to the default.

**`compressToolResults: false`**. Leaves every tool result whole. The other three steps still run.

**`preserveSystemPrompt: true`**. Keeps system messages out of all four steps: not folded, not deduplicated, not dropped as a repeat.

Nothing sent once is dropped. Apart from the tool-result cut, every step removes only what is there twice: a second system message with the same text, and a message equal to the one before it in every field — role, content, `tool_calls`, `name` — neither of them a tool result.

**Prompt cache.** Dropping a message or folding whitespace changes the prefix of the request, and a provider caches on that prefix: the request after each change, and every turn of a conversation whose history keeps changing, is billed as uncached input. On a long history read back many times that is a fraction of what the steps save; on a short history that would have been a cache hit every turn it can cost more than it saves.

Only `body.messages` is read, so it acts on a Chat or an Anthropic request. A Responses or a Gemini request carries its history elsewhere and goes on unchanged; so does a request whose body it cannot read, because an exception here would take the request down with it.

Ported from OmniRoute's lite engine (`open-sse/services/compression/lite.ts`, MIT); what was left out, and the four places this one deliberately differs, are listed in `PROVENANCE.json`.

中文：把请求的历史发得更小——连续空行折叠成一行空行、逐字重复的 system 提示与紧挨着重复的消息去掉、历史中超过 `maxToolLength` 的工具结果在词边界处截断并标上 `[truncated]`。正在发送的这一轮（最后一条 assistant 之后的消息）四步都不碰：补丁行、Markdown 硬换行、行尾空白原样发出；整段没有 assistant 的首轮请求同样原样发出。判"重复"比的是整条消息不是内容——system 要整段文本相同，其它消息要每个字段（`tool_calls`、`name` 都算）都相同。只读 `body.messages`，Chat 与 Anthropic 请求生效；`compressToolResults: false` 不截断工具结果，`preserveSystemPrompt: true` 让 system 消息不被任何一步改动。prompt cache 的账：删一条消息或折叠空白都会改掉请求前缀，提供方按前缀缓存，改动后的那次请求、以及历史一直在变的后续轮次，输入按未缓存价计费——历史长且反复回读时这笔开销只占省下的一小部分，历史短且本来每轮都命中缓存时可能得不偿失。
