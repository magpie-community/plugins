# opencode-vllm-sr-auth

[OpenCode](https://opencode.ai) provider plugin for [vLLM-SR](https://app.vllm-sr.ai) — the free System Duo service from the [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) project. It also works in [magpie](https://usemagpie.ai) without changes.

One key (or none: the plugin can make one), two systems on one base URL:

- **System One**, the decision models: they answer typed questions about text, images and videos with calibrated probabilities, from one forward pass per question. They generate no text, so they are not chat models: the plugin marks them `decides: true`, which magpie reads as "offered as a routing-group classifier, hidden from agents' model lists".
- **System Two**, `vllm-sr/auto`: an OpenAI Chat Completions endpoint with streaming and function calling. vLLM Semantic Router reads each request, asks its decision model for the request's signals, and picks a model from its pool (today GLM-5.3-Flash, Qwen3.8-Flash-Next and Qwen3.8-27B).

## Models

System One:

| Model | Size | Question types |
| --- | --- | --- |
| `vllm-sr/d3-ultra` | 27B | choice, noul, score, box, track |
| `vllm-sr/d3-flash` | 9B | choice, noul, score, box |
| `vllm-sr/vela3-turbo` | 27B | d3-ultra's set + span |
| `vllm-sr/vela3-flash` | 9B | d3-flash's set + span |

The list is refreshed from [`GET /v1/models`](https://app.vllm-sr.ai/docs) for signed-in accounts — one call answers both systems: `"system": "two"` marks System Two, `alias_of` marks retired names. Retired names (`d3-turbo`, `d3`, `d3-mini`, `d3-nano`, `d3-lite`, `d3-edge`) still work upstream and are served by the model each names, so they are not listed separately.

System Two:

| Model | Pool today |
| --- | --- |
| `vllm-sr/auto` | GLM-5.3-Flash, Qwen3.8-Flash-Next, Qwen3.8-27B |

## Sign in

Two ways to sign in, both without an account:

- **Create a key automatically** — no prompts: the plugin solves the key challenge from the [docs](https://app.vllm-sr.ai/docs#authentication) (a SHA-256 proof of work, a second or two) and stores the new key. Each network address may create a limited number of keys per hour; when the limit is hit the sign-in fails with `429 key_creation_limited` and its `Retry-After`.
- **API key** — paste an existing key (one click at [app.vllm-sr.ai](https://app.vllm-sr.ai/keys); keys are shown once, `sk-vsr-…`). Keys made on the older decision.vllm-sr.ai work as they are.

```sh
magpie plugin add opencode-vllm-sr-auth
magpie plugin login vllm-sr              # pick a method
magpie plugin login vllm-sr "Create a key automatically"
```

In the magpie app: Plugins → add the plugin → sign in on the vLLM-SR row.

## Where the key is stored

In magpie's `plugin-auth.json` (permissions 600), the same file and format OpenCode uses for `auth.json`, so a sign-in can move between the two.

## Usage in magpie

- The provider id is `vllm-sr`. Point an agent at `vllm-sr/auto` for free chat, or a routing group's intent rules at a decision model, e.g. `classifier=vllm-sr/d3-flash`.
- `magpie quota` shows each model's daily quota (requests and tokens, resetting 00:00 UTC): System One per model, System Two for the pool behind `auto`, read live from the key's usage endpoints.

## Privacy

The service may log every request and response, images and videos included, and use them to improve the service. Do not send sensitive data. See its [privacy notice](https://app.vllm-sr.ai/privacy).

## License

MIT
