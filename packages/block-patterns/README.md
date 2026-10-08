# @magpie-community/middleware-block-patterns

Rejects requests that contain text you list, as [magpie](https://usemagpie.ai) gateway middleware. A request with one of your words or patterns in it is turned away with a 400 before it reaches a model; everything else is sent on untouched.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-block-patterns`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options block-patterns '<json>'`.

## Options

```json
{ "words": ["project-codename"],
  "patterns": ["\\b\\d{3}-\\d{4}\\b"],
  "system": true,
  "message": "" }
```

- **`words`.** Plain substrings, matched anywhere in the text, ignoring case.
- **`patterns`.** Regular expressions, also matched ignoring case.
- **`system`.** `true` (the default) reads the system prompt as well as the user's turns, so a word in either turns the request away. `false` leaves the system prompt out and reads the user's turns alone.
- **`message`.** The error text to use in place of the default one.

## What it reads

Every content shape an agent sends, in all four APIs magpie serves: plain string content, `text` and `input_text` blocks, Responses `input` items, and Gemini `parts`. Anthropic, Chat Completions, Responses and Gemini are all covered.

Every user turn is read, not only the last one, so a word earlier in the conversation is caught. System prompts are read too, unless you set `system` to `false`.

Tool calls, tool arguments, tool results and Gemini thought parts are never read, so a file an agent reads that contains a word doesn't stop it, and a word the model said back doesn't either.

## What it is not

This is literal matching, not a safety classifier. It does not understand what a request means, and it does not judge whether anything is harmful. A synonym, a paraphrase, a misspelling or a word split by formatting passes it. Don't rely on it as a real guardrail against a determined prompt: use it to keep listed text — an internal codename, a customer's name, an unreleased feature — out of what your gateway sends.

中文：按你列出的词与正则拒绝请求（纯字面匹配，不是安全分类器），可选择是否读取 system 提示词。
