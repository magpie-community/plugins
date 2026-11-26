# @magpie-community/middleware-required-array

Give every tool parameter schema an explicit `required` array.

Some OpenAI-compatible relays validate function schemas strictly: a function whose
`parameters` is `{"type":"object","properties":{}}` has no `required` key, and the
relay rejects the whole request with

```
Invalid schema for function 'get_goal': null is not of type "array"
```

before any model is called. Magpie's own zero-parameter tools (such as `get_goal`)
have exactly that shape, so one of them is enough to fail an entire turn. This
middleware runs on every request before routing and adds `"required": []` to every
object schema that has `properties` but no `required`. Nothing else is changed.

## Install

```sh
magpie plugin add @magpie-community/middleware-required-array
```

No options. Remove it with `magpie plugin rm required-array`.

## What it touches

| Protocol | Where |
| --- | --- |
| OpenAI Chat | `tools[].function.parameters` |
| OpenAI Responses | `tools[].parameters` on `type: "function"` tools |
| Anthropic Messages | `tools[].input_schema` |

It recurses into `properties`, `items`, `oneOf`/`anyOf`/`allOf` and `$defs`, up to
12 levels deep.

- Only **missing** `required` arrays are added; existing arrays are never modified.
- Tools without a `parameters` object and built-in tools (`web_search`, …) are left alone.
- Gemini is left alone on purpose: its schema subset has stricter rules around empty
  `required` arrays.
- Idempotent: a second pass changes nothing.
- Fails open: if the hook throws, magpie sends the original request.

## 中文

有些 OpenAI 兼容中转会严格校验函数 schema：`parameters` 为
`{"type":"object","properties":{}}` 时没有 `required` 键，中转会直接返回
`null is not of type "array"`，整个请求在调用模型之前就失败。Magpie 自己的
零参数工具（如 `get_goal`）正是这种形状。

本中间件在路由之前为所有「有 `properties` 但没有 `required`」的对象 schema 补上
`"required": []`，其他内容一律不动。只补缺失值，不修改已有数组；无参数工具、
内置工具和 Gemini 不受影响；钩子出错时按原请求发送。
