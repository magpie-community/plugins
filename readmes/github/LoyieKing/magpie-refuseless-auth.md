# magpie-refuseless-auth

A magpie / OpenCode provider plugin for Refuseless, which serves refusal-removed open-weight models over an OpenAI-compatible Chat Completions API.

## Install

```bash
magpie plugin add ./magpie-refuseless-auth
# or from npm
magpie plugin add magpie-refuseless-auth
```

## Sign in

The provider id is `refuseless`.

1. Open <https://refuseless.com/console/api-keys> and create an API key. It starts with `abl_`.
2. Sign in through magpie:

```bash
magpie plugin login refuseless
```

The plugin has a single **Refuseless API key** field. Paste the key there; the field's hint points to <https://refuseless.com/console/api-keys>, where the key is created.

In the app, open the plugin, click sign in on the Refuseless row, and paste the key. Sign-ins are stored in magpie's `plugin-auth.json` (mode 600), in the same shape as OpenCode's `auth.json`.

## Credits

The account's usage comes from `GET /v1/credits`, which costs nothing. A key without its own budget shows the account's USD balance. A key with a budget shows what it can still spend as a credit window, capped by `key_limit` and holds from in-flight requests.

## Models

Each account's model list comes from `GET /v1/models`, so models added to the catalog appear automatically. Each model's `context_length`, `reasoning_efforts`, and whether refusals were removed come from that endpoint.

Current catalog:

| Model id | Context | Notes |
| --- | --- | --- |
| `glm-5.3-abliterated` | 1,048,576 | GLM 5.3 with refusals removed; text |
| `glm-5.3-flash-abliterated` | 1,048,576 | Faster and cheaper; text and images |
| `deepseek-v4.1-flash-abliterated` | 1,048,576 | DeepSeek V4.1 Flash with refusals removed |
| `deepseek-v4.1-flash-fast` | 1,048,576 | DeepSeek V4.1 Flash Fast |
| `minimax-m3.1-flash` | 1,048,576 | MiniMax M3.1 Flash |

Reasoning levels come from the model's `reasoning_efforts` (usually `low`, `high`, and `max`; some DeepSeek models also offer `off`). Models support tool calls; `glm-5.3-flash-abliterated` accepts image input.

## Requests

Requests go to `https://api.refuseless.com/v1/chat/completions` through `@ai-sdk/openai-compatible`. magpie converts requests from Claude Code, Codex, Gemini, and other clients into Chat Completions; streaming replies, tool calls, and `reasoning_content` are passed through unchanged.

The plugin sends only the request body and `Authorization`; it does not record prompts or replies. The key stays in magpie's `plugin-auth.json` and is never written to config or logs.

## OpenCode

The package is also an OpenCode v1 plugin. `magpie.icon` and `auth.usage` are magpie-only fields that OpenCode ignores; sign-in, model lists, and requests work in both.
