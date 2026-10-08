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
- **`system`.** `true` (the default) reads the system prompt as well as the user's turns, so a word in either turns the request away. `false` leaves every system prompt out and reads the user's turns alone. Where each API keeps its system prompt is listed under "What it reads".
- **`message`.** The error text to use in place of the default one.

## What it reads

Every content shape an agent sends, in all four APIs magpie serves: plain string content, `text` and `input_text` blocks, Responses `input` items, and Gemini `parts`. Anthropic, Chat Completions, Responses and Gemini are all covered.

Every user turn is read, not only the last one, so a word earlier in the conversation is caught. System prompts are read too, unless you set `system` to `false`. Each API keeps its system prompt in its own place, and all of them are read:

| API | Read when `system` is true |
|---|---|
| Anthropic | the top-level `system` field, as a string or as text blocks, and any `system` / `developer` message |
| Chat Completions | any `system` / `developer` message |
| Responses | `instructions`, and any `system` / `developer` input item |
| Gemini | `systemInstruction` and `system_instruction`, as a string or as a `{ parts }` object |

Tool calls, tool arguments, tool results and Gemini thought parts are never read, so a file an agent reads that contains a word doesn't stop it, and a word the model said back doesn't either.

## If a pattern does not compile

A `patterns` entry that is not a valid regular expression is ignored, and the rest of your options still work. Nothing is thrown: a typo in one entry cannot turn away every request the gateway sees. Fix the pattern in **Plugins › Installed › Options** — the entries that failed are not reported, so check the spelling if a word you listed seems to be passing through.

## What it is not

This is literal matching, not a safety classifier. It does not understand what a request means, and it does not judge whether anything is harmful. A synonym, a paraphrase, a misspelling or a word split by formatting passes it. Don't rely on it as a real guardrail against a determined prompt: use it to keep listed text — an internal codename, a customer's name, an unreleased feature — out of what your gateway sends.

## Word Guard vs this

Both match a list of words and regular expressions, and both can turn a request away, so it is worth saying which to install.

- **Word Guard** can mask a match and send the request on, and can mask matches in the replies as well. It reads only the last user message by default, and never reads a system prompt.
- **This one** only turns requests away — there is no mask and it never reads replies. In exchange it reads every user turn and every system prompt, wherever the API keeps it.

Install this one when you want a listed word to be an error rather than something silently rewritten, and when a system prompt is part of what you want to keep off the wire. Install Word Guard when you would rather the request go through with the word blanked out. They can be installed together.

magpie already redacts secrets (API keys and tokens) before a request leaves your computer, and puts them back in the reply. Neither package is needed for that.

中文：按你列出的词与正则拒绝请求（纯字面匹配，不是安全分类器），可选择是否读取 system 提示词。
