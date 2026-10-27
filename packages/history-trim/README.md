# @magpie-community/middleware-history-trim

A request's history, sent smaller, as [magpie](https://usemagpie.ai) gateway middleware. It folds a run of blank lines, drops a system prompt written twice and a message repeated right after itself, and cuts a past tool result longer than `maxToolLength` at a word boundary.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-history-trim`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options history-trim '<json>'`.

## Options

```json
{ "maxToolLength": 2000 }
```

**`maxToolLength`** (the default, 2000). A tool result from an earlier turn longer than this many characters is cut to it, at the nearest word boundary within 80 characters, and ends with `\n...[truncated]`.

- The turn being sent now is never cut. A message at or after the last assistant message is the history the model has not read yet, so it goes out whole; a history with no assistant message in it is left whole too.
- Both shapes are cut: a Chat `role: "tool"` message whose content is a string, and an Anthropic `tool_result` block inside a content array, whether its content is a string or an array of text parts.
- A number below 256 or above 1000000 is not a length anyone means, and falls back to the default.

**`compressToolResults: false`**. Leaves every tool result whole. The other three steps still run.

**`preserveSystemPrompt: true`**. Keeps system messages out of all four steps: not folded, not deduplicated, not dropped as a repeat.

Nothing sent once is dropped. Apart from the tool-result cut, every step removes only what is there twice: a second system message whose first 200 trimmed characters are the one already sent, and a message whose text is character for character the one before it, in the same role, neither of them a tool result.

Only `body.messages` is read, so it acts on a Chat or an Anthropic request. A Responses or a Gemini request carries its history elsewhere and goes on unchanged; so does a request whose body it cannot read, because an exception here would take the request down with it.

Ported from OmniRoute's lite engine (`open-sse/services/compression/lite.ts`, MIT); what was left out is listed in `PROVENANCE.json`.

## The full plugin

This is one engine of a larger plugin: [magpie-compress-core](https://github.com/manjughosa/magpie-compress-core) — fifteen engines, four presets, a settings panel, and a lab that runs a prompt through every engine and shows what each one saved. It carries a page of its own, so the one-file rule this repository keeps does not bind it. Install it from its repository:

```sh
magpie plugin add github:manjughosa/magpie-compress-core
```

It stays out of Discover. The full plugin is maintained in its own repository, and this package is the part of it that fits here.

中文：把请求的历史发得更小——连续空行折叠成一行空行、逐字重复的 system 提示与紧挨着重复的消息去掉、历史中超过 `maxToolLength` 的工具结果在词边界处截断并标上 `[truncated]`（正在发送的这一轮不动）。只读 `body.messages`，Chat 与 Anthropic 请求生效；`compressToolResults: false` 不截断工具结果，`preserveSystemPrompt: true` 让 system 消息不被任何一步改动。本包是完整插件 [magpie-compress-core](https://github.com/manjughosa/magpie-compress-core) 的一个引擎切片，完整版含 15 个策略、四档预设、设置面板与实验室，用 `magpie plugin add github:manjughosa/magpie-compress-core` 安装。
