# @magpie-community/middleware-gemini-turn-sanitizer

Sanitize conversation turn sequences and tool call alternation for Google Gemini and Antigravity (Google Code Assist) as [magpie](https://usemagpie.ai) gateway middleware.

## Problem it solves

Google Gemini API enforces strict alternation rules on conversation turns:
> `"Please ensure that function call turn comes immediately after a user turn or after a function response turn."`

When client agents (such as Hermes Agent, Claude Code, Cursor, Alma) perform context compression/truncation or handle out-of-band events, conversation histories can end up with:
1. An `assistant` turn (especially one with `tool_calls`) as the very first turn after system prompts.
2. An `assistant` turn with `tool_calls` immediately following another assistant turn without an intervening `user` or `tool` result.

Google Code Assist upstream immediately rejects these requests with HTTP 400.

This middleware automatically intercepts outgoing requests in the gateway:
- **First turn defense**: If the first message in the conversation is `assistant` / `model`, prepends a synthetic user turn (`"Continue."`).
- **Tool call sequence defense**: If an assistant turn contains `tool_calls` (or Anthropic `tool_use`), ensures the preceding turn is a `user` or `tool` / `tool_result` turn, inserting a synthetic user turn (`"Continue."`) if not.
- Supports OpenAI Chat completions, Anthropic Messages (`body.messages`), and native Gemini (`body.contents`).

## Installation

Install from magpie's **Plugins › Discover**, or via CLI:
```sh
magpie plugin add @magpie-community/middleware-gemini-turn-sanitizer
```

Configure options under **Plugins › Installed › Options**, or via CLI:
```sh
magpie plugin options gemini-turn-sanitizer '{"models": ["gemini", "antigravity"]}'
```

## Options

```json
{
  "models": ["gemini", "antigravity"],
  "user_content": "Continue."
}
```

- **`models`**: Array of model name substrings to apply this middleware to. If empty or omitted, applies to all models. Defaults to `["gemini", "antigravity"]`.
- **`user_content`**: The text content for synthetic user turns. Defaults to `"Continue."`.

中文：修复 Google Gemini / Antigravity 上游严格的轮次交替与工具调用衔接校验（`Please ensure that function call turn comes immediately after a user turn or after a function response turn`）。当客户端在上下文裁剪或工具调用断档后首轮出现 assistant 或连续 assistant+tool_call 时，自动补齐合法 user 轮次，避免 400 报错。
