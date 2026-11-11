# Magpie Tool Schema Fix

[简体中文](#中文说明) | [English](#english)

A Magpie gateway middleware that fills in `"type": "object"` for untyped **object-shaped tool parameter schemas**, only for the models you name. A temporary workaround for [yetone/magpie#2179](https://github.com/yetone/magpie/issues/2179).

## 中文说明

### 解决什么问题

Codex Desktop 的部分 `codex_app` 工具定义中，JSON Schema 包含 `properties` / `required`，但没有声明 `type`。部分严格校验工具定义的上游会因此拒绝整个请求，通常表现为 HTTP 400 `invalid_request_error`。该中间件在 Magpie 的 `onRequest` 阶段递归补齐对象 Schema 的类型。

### 只对指定模型生效（默认）

中间件**默认只处理 `mirasim/gemini-4-argon`**（`DEFAULT_MODELS`），其他模型（GPT、Claude、Gemini、DeepSeek、Kimi 等）的请求原样通过，不做任何修改。

想覆盖更多模型，在插件 **Options** 里设置 `models`：

```json
{
  "models": ["mirasim/gemini-4-argon", "other-vendor/strict-model"],
  "agents": ["codex"]
}
```

- `models`：数组，或以逗号分隔的字符串。支持精确名、前缀通配（`some-vendor/*`）和全通配 `"*"`（对所有模型生效）。留空则回落到默认的 `mirasim/gemini-4-argon`。
- `agents`（可选）：设置后仅处理该客户端（如 `codex`、`dsh`、`zcode`）；不设置则不做客户端限制。
- 模型名匹配大小写不敏感；`ctx.model` 与请求体里的 `model` 任一命中即可。

`package.json` 里的 `magpie.options` 只是编辑器里的示例，实际以你在 Magpie 中保存的 Options 为准。

### 处理范围

- 处理 Responses、Chat Completions、Anthropic Messages 中的工具定义，以及 Responses namespace 的子工具。
- 处理嵌套 `properties` 和数组 `items` 内的对象。
- 已有显式 `type` 的 Schema 保持不变；`$ref`、组合 Schema（`anyOf`/`oneOf`/`allOf`）、`const` 和 `enum` 不强行推断类型。
- 无第三方运行时依赖；不向外部服务发送数据。

### 安装

在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中找到本仓库并安装（仓库带 `magpie-plugin` GitHub Topic）；或运行：

```sh
magpie plugin add github:Essaim8/magpie-tool-schema-fix
```

也可以把仓库下载到本地后执行 `magpie plugin add ./magpie-tool-schema-fix`。在「插件 → 已安装」中确认中间件已开启。

### 使用及限制

此插件只修改 **Magpie 接收到的原始请求体**，发生在路由和协议转换之前；它无法修复 Magpie 在后续协议转换中**新产生的**无类型 Schema。因此，与 #2179 在最终上游发送位置实施的原生补丁相比，覆盖范围不同。修复随 Magpie 正式版本发布后，建议移除本临时中间件。

执行测试：`npm test`（仅使用 Node.js 内置测试运行器，不安装依赖）。

## English

Magpie gateway middleware for untyped object-like JSON Schemas in tool parameters. It recursively fills in missing `"type": "object"` for object shapes and preserves existing types, unions, `$ref`, enum and const schemas.

**Scope:** by default it only runs for `mirasim/gemini-4-argon` (`DEFAULT_MODELS`); every other model's requests pass through untouched. Set the `models` option (an array or a comma-separated string; exact names, a `some-vendor/*` prefix, or `"*"` for all) to cover more models, and the optional `agents` option to narrow it to one client.

It runs in `onRequest` *before* routing/translation, so it cannot fix schemas newly introduced *by* a downstream protocol converter. This is an experimental workaround, not a confirmed replacement for the upstream patch. See [issue #2179](https://github.com/yetone/magpie/issues/2179).

Install with `magpie plugin add github:Essaim8/magpie-tool-schema-fix`, or use the Magpie Plugins Discover page once the repository is indexed under the `magpie-plugin` GitHub topic. No npm publication is required.

Tests: `npm test` with Node.js. No dependencies.

## License

MIT.
