# opencode-sensenova-auth

A [magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) provider plugin for
**SenseNova Token Plan (商汤日日新)**, at `https://token.sensenova.cn`.

It registers SenseNova 6.8 Flash Lite, DeepSeek V4/V4.1 Flash, GLM-5.2 and Kimi K3,
including their context limits, multimodal capabilities and reasoning controls.

```sh
magpie plugin add opencode-sensenova-auth
magpie plugin login sensenova       # paste an sk-… key
magpie provider test sensenova sensenova-6.8-flash-lite
```

Create a key in the [SenseNova console](https://platform.sensenova.cn), then select
`sensenova/sensenova-6.8-flash-lite` in an agent driven by magpie.

From GitHub instead of npm:

```sh
magpie plugin add github:itgo067/magpie-plugin-sensenova
```

## 中文说明

1. 在 [SenseNova 控制台](https://platform.sensenova.cn) 的 Token Plan 中创建 `sk-…` 密钥。
2. 执行上面的安装、登录和测试命令。
3. 选择 `sensenova/sensenova-6.8-flash-lite`，或其他已接入的对话模型。

默认使用 OpenAI Chat Completions。接入 Claude Code 或 Codex 时可切换协议：

```sh
magpie plugin options opencode-sensenova-auth '{"protocol":"anthropic"}'
magpie plugin options opencode-sensenova-auth '{"protocol":"responses"}'
```

选项名是 npm 包名，不是仓库名；可用 `magpie plugin list` 查看实际安装名称。

## Wire APIs

| `protocol` | SDK | Base URL | Endpoint |
| --- | --- | --- | --- |
| `chat` (default) | `@ai-sdk/openai-compatible` | `https://token.sensenova.cn/v1` | `/chat/completions` |
| `anthropic` | `@ai-sdk/anthropic` | `https://token.sensenova.cn` | `/v1/messages` |
| `responses` | `@ai-sdk/openai` | `https://token.sensenova.cn/v1` | `/responses` |

Chat exposes each model's documented `reasoning_effort` variants, including `none` to
disable thinking. Anthropic uses `output_config.effort` and `thinking`. The current
Responses compatibility endpoint ignores non-default effort levels, so it only exposes
the useful `none` variant.

## Models

| ID | Context | Maximum output | Input |
| --- | ---: | ---: | --- |
| `sensenova-6.8-flash-lite` | 262,144 | 65,536 | text, image |
| `deepseek-v4-flash` | 1M | 384,000 | text |
| `deepseek-flash` | 1M | 393,216 | text, image; video on Chat |
| `deepseek-v4.1-flash` | 1M | 65,536 | text |
| `glm-5.2` | 1M | 131,072 | text |
| `kimi-k3` | 1M | model-dependent | text, image (Base64) |

With authentication, `GET /v1/models` refreshes model limits, modalities and pricing and
adds newly available text models. Network or authorization failures leave the static
catalog intact. The live endpoint can report lower limits than the underlying model's
maximum; its values take precedence for the current Token Plan deployment.

The U1.5 Lite/Fast models are deliberately not registered as chat models: they only use
`/v1/images/generations` and `/v1/images/edits`, which magpie's chat providers do not
serve.

## Configuration

Provider and model fields are merged without discarding defaults:

```json
{
  "provider": {
    "sensenova": {
      "models": {
        "sensenova-6.8-flash-lite": { "name": "SenseNova Flash Lite" }
      }
    }
  }
}
```

Token Plan consumes account credits with rolling five-hour and weekly limits. Static
model costs are therefore zero rather than invented token prices; any prices returned by
the live model endpoint are retained. Check credits and usage in the SenseNova console.

Live checks on 2026-10-27 passed for Chat, Anthropic Messages and Responses, including
Chat streaming and function calling. The gateway can still return a small reasoning field
when `reasoning_effort: none` or `thinking: disabled` is requested.

## Development

```sh
bun test
magpie plugin add .
```

The plugin has no runtime dependencies. It exports `SenseNovaAuthPlugin` and `_internal`
for offline tests. API behavior is based on the [official documentation](https://platform.sensenova.cn/docs).

## License

MIT
