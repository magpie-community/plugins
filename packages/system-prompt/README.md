# @magpie-community/middleware-system-prompt

New API's **系统提示词** (a channel's `system_prompt` and its override switch) as [magpie](https://usemagpie.ai) gateway middleware. It gives the requests agents send a system prompt of yours, in each API's own place for one:

| API | Where the prompt goes |
| --- | --- |
| Anthropic | `system` |
| Chat | the first `system` or `developer` message |
| Responses | `instructions` |
| Gemini | `systemInstruction` |

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-system-prompt`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options system-prompt '<json>'`.

## Options

```json
{ "system_prompt": "Reply in the language the user writes in.",
  "override": true, "position": "append",
  "agents": ["claude"], "models": ["deepseek"] }
```

- **No system prompt yet.** A request without one gets yours.
- **`override`.** A request that has its own prompt keeps it unchanged, unless `override` is `true`. Then yours goes in as well, placed by `position`:
  - `"append"` (the default) puts yours after it. Agents cache their own prompt, so adding after it keeps that cache.
  - `"prepend"` puts yours before it, as New API does. This makes the provider read the whole prompt again on every turn.
- **`agents`.** When given, the prompt applies only to these agents, by magpie's agent ids: `claude`, `codex`, `opencode`, and so on.
- **`models`.** When given, the prompt applies only to models whose names begin with one of these prefixes, case aside. A prefix may begin magpie's whole model id (`google/gemini`) or the model's own name after its provider (`gemini-3.8-flash` matches `google/gemini-3.8-flash` and `openrouter/google/gemini-3.8-flash`). In a routing group the prompt goes only to the tries on a model in `models`: to give Gemini 3.8 Flash a prompt and no other model, whether it is asked directly or through a group, use (`override`, since most agents send a prompt of their own)

  ```json
  { "system_prompt": "Answer in Chinese.", "override": true, "models": ["gemini-3.8-flash"] }
  ```

Codex sends its own model instructions, and changing them can change how its models behave. Use `agents` to leave Codex out if you don't want that.

中文：New API 的「系统提示词」，作为 magpie 网关中间件。默认把你的提示词加在 agent 自己的提示词之后，这样不会破坏提示缓存。`models` 按模型名前缀匹配（不分大小写），可以写完整 id（如 `google/gemini`），也可以只写模型名（如 `gemini-3.8-flash`，会匹配 `google/gemini-3.8-flash`、`openrouter/google/gemini-3.8-flash`）；路由组里只有发往这些模型的请求会加上提示词。例如只给 gemini-3.8-flash 加提示词：`{"system_prompt": "用中文回答。", "override": true, "models": ["gemini-3.8-flash"]}`。
