# @magpie-community/middleware-word-guard

New API's **敏感词过滤** as [magpie](https://usemagpie.ai) gateway middleware. It keeps the words and patterns you list out of what agents send: a request with one is turned away, or has the word masked. It can mask them in replies too.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-word-guard`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options word-guard '<json>'`.

## Options

```json
{ "words": ["project-codename"],
  "patterns": ["\\b\\d{3}-\\d{4}\\b"],
  "action": "reject",
  "check": "last" }
```

- **`words`.** Words matched anywhere in the text, ignoring case.
- **`patterns`.** Regular expressions, also matched ignoring case.
- **`action`.** `reject` (the default) turns the request away with a 400 that names the word, in the agent's API's error shape. `mask` replaces each match with `mask` (default `***`) and sends the request on.
- **`check`.** `last` (the default) reads only the last user message that has text, which is the turn being sent. That is what New API reads. `all` reads every user message, so a word earlier in the conversation keeps turning requests away.
- **`replies`.** Set it to `true` to mask matches in the text that comes back as well, in every API magpie serves — Anthropic, Chat, Responses and Gemini, streamed or whole. A word split across two streamed events isn't caught.
- **`message`.** The error text to use in place of the default one.

The middleware reads only the user's own text. It doesn't read tool results, tool calls or the system prompt, so a file an agent reads that contains the word doesn't stop it.

If you want a listed word to be a 400 rather than something masked, and you also want every earlier user turn and the system prompt read, that is [block-patterns](../block-patterns). It never masks and never reads replies, so the two can be installed together.

magpie already redacts secrets (API keys and tokens) before a request leaves your computer, and puts them back in the reply. You don't need this middleware for secrets.

中文：New API 的「敏感词过滤」，作为 magpie 网关中间件。只检查用户自己写的文字，可拒绝请求或替换成 `***`，也可以替换回复里的词。
