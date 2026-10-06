# OpenCode Zen Free

Use OpenCode Zen's free models in Magpie with the public credential. No runtime dependencies. Requests go directly to `https://opencode.ai/zen/v1`.

```sh
magpie plugin add @magpie-community/opencode-zen-free-auth
magpie plugin login opencode-zen-free
```

Enter `public` in the key field. The plugin always stores and sends the public credential. Magpie keeps it in `plugin-auth.json` in its configuration directory; the plugin writes no credential files.

Models are addressed as `opencode-zen-free/<model>`, for example `opencode-zen-free/big-pickle` and `opencode-zen-free/muse-spark-1.3-contributor-free`.

## Behavior

- Discovers live models through Zen `/models`, the OpenCode capability catalog and its published endpoint table.
- Includes free-named or zero-input/zero-output-cost models; excludes retired models and unsupported protocols, including SystemOne.
- Supports native Chat Completions, Responses and Anthropic Messages. Magpie translates the agent's protocol.
- Sends streaming upstream requests and the core agent tool declarations (`bash`, `edit`, `glob`, `grep`, `read`), preserving existing definitions. The agent executes tools; clients must handle any tool calls they receive.
- Streams responses without buffering, or assembles SSE into JSON for non-streaming clients. Preserves reasoning, tool arguments and usage.
- Preserves HTTP errors, Retry-After and cancellation. SSE errors return promptly; truncated streams fail explicitly.
- Uses stable OpenCode-format session IDs and defaults to two concurrent requests.
- Reports the free plan with no quota windows: no remaining anonymous quota API is available.

`baseURL`, `catalogURL` and `docsURL` are optional plugin options for compatible endpoints or local testing. Standard fetch follows Magpie's provider/account proxy settings.

## Verification

```sh
bun scripts/check.mjs zen-free
bun test packages/zen-free
```

53 local tests pass on Node 24 and Bun 1.3.14. Verified with Magpie's real Bun host: public login, ten discovered models, Chat and Responses provider tests, Chat JSON requests and Anthropic-to-Responses gateway conversion. Upstream availability is dynamic: some listed models can return overload, unavailable endpoint or region errors.

## 中文

在 Magpie 中安装后，选择 OpenCode Zen Free 并登录，密钥填写 `public`。模型自动发现，支持流式输出、普通 JSON、工具调用和思考内容。登录信息保存在 Magpie 配置目录的 `plugin-auth.json`。免费模型会更新或临时不可用；以每次真实上游响应为准。

供应商图标：`https://opencode.ai/favicon-v3.ico`。
