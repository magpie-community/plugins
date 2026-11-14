# @magpie-community/middleware-system-prompt

New API's **系统提示词** (a channel's `system_prompt` and its override switch) as [magpie](https://usemagpie.ai) gateway middleware. It gives the requests agents send a system prompt of yours, in each API's own place for one:

| API | Where the prompt goes |
| --- | --- |
| Anthropic | `system` |
| Chat | the last `system` or `developer` message before the conversation |
| Responses | `instructions` when it is set; when it is empty, the last `developer` or `system` message of `input`'s leading run |
| Gemini | `systemInstruction` |

Agents do not always use the field an API reserves for a system prompt. OpenAI's Responses API lets an agent put its prompt in `developer` messages in `input` and leave `instructions` empty (the Codex-style agents do), and Chat clients may send more than one `system` message. The prompt goes to the last of those messages, which is the one the model reads as the final word; writing it to `instructions` alone would leave it ahead of the agent's own prompt, where that prompt overrides it.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-system-prompt`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options system-prompt '<json>'`.

## Options

```json
{ "system_prompt": "Reply in the language the user writes in.",
  "override": true, "position": "append",
  "agents": ["claude"], "models": ["deepseek"] }
```

- **No system prompt yet.** A request without one gets yours.
- **`override`.** A request that has its own prompt keeps it unchanged, unless `override` is `true` — whichever way `position` would have placed it. Then yours goes in as well, placed by `position`:
  - `"append"` (the default) puts yours after it. Agents cache their own prompt, so adding after it keeps that cache.
  - `"prepend"` puts yours before it, as New API does. This makes the provider read the whole prompt again on every turn.
- **`agents`.** When given, the prompt applies only to these agents, by magpie's agent ids: `claude`, `codex`, `opencode`, and so on.
- **`models`.** When given, the prompt applies only to models whose names begin with one of these prefixes, case aside. A prefix may begin magpie's whole model id (`google/gemini`) or the model's own name after its provider (`gemini-3.8-flash` matches `google/gemini-3.8-flash` and `openrouter/google/gemini-3.8-flash`). In a routing group the prompt goes only to the tries on a model in `models`: to give Gemini 3.8 Flash a prompt and no other model, whether it is asked directly or through a group, use (`override`, since most agents send a prompt of their own)

  ```json
  { "system_prompt": "Answer in Chinese.", "override": true, "models": ["gemini-3.8-flash"] }
  ```

Codex sends its own model instructions, and changing them can change how its models behave. Use `agents` to leave Codex out if you don't want that.

中文：New API 的「系统提示词」，作为 magpie 网关中间件。`override` 为 `false` 时，自带提示词的请求原样不动（无论 `position` 是 append 还是 prepend）。默认把你的提示词加在 agent 自己的提示词之后，这样不会破坏提示缓存。`models` 按模型名前缀匹配（不分大小写），可以写完整 id（如 `google/gemini`），也可以只写模型名（如 `gemini-3.8-flash`，会匹配 `google/gemini-3.8-flash`、`openrouter/google/gemini-3.8-flash`）；路由组里只有发往这些模型的请求会加上提示词。例如只给 gemini-3.8-flash 加提示词：`{"system_prompt": "用中文回答。", "override": true, "models": ["gemini-3.8-flash"]}`。
