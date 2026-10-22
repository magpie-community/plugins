# @magpie-community/middleware-multi-path-router

A model map with gates in front of it, as [magpie](https://usemagpie.ai) gateway middleware. The model an agent asks for is sent upstream as another model, chosen from the request itself:

1. **Images** go to a vision model.
2. **A large context** (an estimate in tokens) goes to a long-context model.
3. **An off-peak window** you set goes to another model during those hours.
4. Otherwise the **plain mapping** applies.

The gates run in that order, and the first one with a target wins. Replies then name the model the agent asked for, so an agent that reads its model's name back (Claude Code does, to size its context window) sees the name it asked for.

That is all it does. There is no classifier, no benchmark scoring and no automatic escalation; a gate either matches or it does not.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-multi-path-router`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options multi-path-router '<json>'`.

## Options

```json
{
  "constraints": {
    "vision": "local-qwen/Qwen3-27B",
    "tokens_gte": { "threshold": 64000, "target": "grok/grok-4@500k" }
  },
  "schedule": {
    "offpeak": { "days": [0, 6], "start": "00:30", "end": "08:30", "tz": 8 },
    "offpeak_mapping": { "smart-router": "deepseek/deepseek-chat" }
  },
  "mapping": { "smart-router": "deepseek/deepseek-reasoner" }
}
```

Every part is optional; the middleware leaves the request alone when nothing matches.

### `mapping`

A name maps to its target. A key written `/like this/` is a regular expression. `"*"` is the fallback for any name the other keys do not match. Targets must be strings; a model named `constructor`, `toString` or `__proto__` is not mapped by accident.

The target has to be a model magpie can route: a model of one of your providers, or one of magpie's own ids (`deepseek/deepseek-chat`, for example). Groups (`group/my-group`) work if magpie routes them.

### `constraints.vision`

When a request carries an image, it is sent to this model instead. Images are found in:

- Anthropic and Chat messages: `image`, `image_url` parts, including inside `tool_result` content
- Responses `input`: `input_image` parts, including inside `function_call_output`
- Gemini `contents`: `inlineData` / `fileData` parts

### `constraints.tokens_gte`

`{ "threshold": 64000, "target": "..." }`, or a plain number for the threshold. When the request's estimated size reaches the threshold, it is sent to the target. The estimate is the characters of text in the system prompt, message text, and tool output (Anthropic `tool_result` content and Responses `function_call_output`, string or parts), divided by four. Images are not counted. It is a rough estimate, not a tokenizer.

### `schedule.offpeak_mapping` and `schedule.offpeak`

During an off-peak window, `offpeak_mapping` is used instead of `mapping`. It is only used while the schedule says off-peak is on, and `cst_deepseek_offpeak: false` turns it off whatever else is set:

- **`schedule.offpeak`** is a window you choose: `{ "days": [1,2,3,4,5], "start": "00:30", "end": "08:30", "tz": 8 }`. `days` are `0` (Sunday) to `6`; omit it for every day. `start`/`end` are `HH:MM`; when `end` is earlier than `start` the window crosses midnight and the early hours belong to the previous day's entry. `tz` is a UTC offset in hours, default `8`. Give a list of windows for several of them.
- **`schedule.cst_deepseek_offpeak: true`** turns on a preset used when no `offpeak` window is given: in UTC+8, weekends all day and weekdays outside 09:00–12:00 and 14:00–18:00. It is only a preset window someone chose to configure; it does not claim to match any vendor's current pricing, and you should check your provider's prices before relying on it. `cst_deepseek_offpeak: false` turns the schedule off, whatever else is set.
- Omitting both while setting `offpeak_mapping` keeps the older behaviour and uses the preset.

The window is evaluated with `options.now` when a test passes a date, and with the current time otherwise.

### `keep_upstream_name`

Set it to `true` to leave the upstream model's name in replies.

## Tests

```bash
bun test packages/multi-path-router
```

`cases.json` runs through the same runner magpie uses to check middleware, and `multi-path-router.test.mjs` covers the window arithmetic and the map lookups.

中文：一个模型映射，前面有三道门：带图片的请求走视觉模型，上下文超过阈值的走长上下文模型，你设置的错峰时段里走 `offpeak_mapping`，都不匹配就按 `mapping` 映射。回复里会还原 agent 请求时用的模型名。没有分类器、基准评分或自动升舱。
