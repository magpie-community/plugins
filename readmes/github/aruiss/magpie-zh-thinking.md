# magpie-zh-thinking

magpie 网关中间件：让经过 magpie 的请求用简体中文思考（thinking）并用简体中文回答，可选要求「过程可见」（先讲思路、再调用工具），并提供思维链开关。

## 开关（Plugins › Installed › Options）

```json
{
  "zh": true,
  "process": false,
  "user_inject": "anthropic",
  "thinking": "auto"
}
```

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `zh` | bool | `true` | 中文注入总开关 |
| `process` | bool | `false` | 过程提示总开关（调用工具前先说明目的） |
| `user_inject` | string | `"anthropic"` | 是否改用户消息：`"anthropic"` 只对 Anthropic 协议改；`"always"` 全改；`"never"` 只改 system |
| `thinking` | string | `"auto"` | 思维链开关：`"auto"` 不改；`"on"` 打开；`"off"` 关闭 |
| `thinking_budget` | number | `2048` | `thinking: "on"` 时 Anthropic 的 `budget_tokens` |
| `thinking_effort` | string | `"high"` | `thinking: "on"` 时 chat/responses 的 effort |

其余可选项：`zh_mode`（`both`/`system`/`user`）、`system_prompt`、`user_prompt`、`process_hint`、`process_in`、`agents`、`models`。

## 思维链开关怎么实现

| 协议 | `off` | `on` |
|---|---|---|
| Anthropic | `thinking: {type: "disabled"}` | `thinking: {type: "enabled", budget_tokens}`（客户端已开则尊重原值） |
| chat | `reasoning_effort: "off"` | `reasoning_effort: "high"`（客户端已设则不覆盖） |
| responses | `reasoning: {effort: "none"}` | `reasoning: {effort: "high"}` |
| gemini | `generationConfig.thinkingConfig.thinkingBudget = 0` | `= thinking_budget` |

实测（WorkBuddy `deepseek-v4.1-flash`）：`reasoning_effort: "off"` 让 reasoning_tokens 归零，`"none"` 同样有效；`"minimal"`/`"low"`/`"high"` 仍有思考。

`off` 会覆盖客户端自己的设置，只在明确要省开销时用；`auto` 完全不碰请求。

## 为什么默认 `user_inject: "anthropic"`

chat / responses 协议下，如果往 messages 里插入一条独立的 user 指令，DSH 这类客户端会把它当成新的用户输入回显，形成「指令 → 回显 → 再注入」的循环。Anthropic 协议（Claude Code）不会回写请求体，所以只对它改用户消息。

## 卸载

从 `plugins.json` 删掉这条，或把 `zh` 设为 `false`。
