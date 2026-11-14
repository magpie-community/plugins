# deeprelay for magpie

Unofficial [magpie](https://usemagpie.ai/) provider plugin for [deeprelay.ai](https://deeprelay.ai/). It connects deeprelay's OpenAI-compatible inference API to magpie and shows the subscription's usage in the Providers page and in `magpie quota`. The package follows OpenCode's provider plugin shape, so it works there too.

Not affiliated with deeprelay.ai or magpie.

## What it connects

- Endpoint: `https://api.deeprelay.ai/v1`
- Sign-in: deeprelay API key (`Authorization: Bearer deeprelay_live_…`)
- API shape: OpenAI Chat Completions (`@ai-sdk/openai-compatible`)
- Models: `GET /v1/models?modality=chat`, fetched per account
- Usage: `GET /v1/billing/subscription`, plus `GET /v1/billing/balance` when a wallet balance matters

The billing endpoints need the `billing:read` scope. A standard dashboard key carries it. A key without it can still run inference; only the usage display is refused.

## Usage shown

`magpie quota deeprelay` and the account card show:

| Window | Meaning |
| --- | --- |
| Monthly input / output | Weighted input and output tokens used in the billing period |
| Weekly input / output (rolling) | Weighted tokens over the rolling 7-day cap. It slides, so there is no reset time |
| Metered usage | This period's list-price cost against the plan's usage ceiling |
| Web searches | Server-side searches used this period against the plan allowance |
| Pay-as-you-go | Calls billed to the credit balance in the last 24 hours |
| Balance | Credit left, when a wallet balance is relevant |

## Install

### From npm

```sh
magpie plugin add magpie-deeprelay
magpie plugin login deeprelay
```

### From GitHub

```sh
magpie plugin add github:ara-hwang/magpie-deeprelay
magpie plugin login deeprelay
```

The repository is tagged `magpie-plugin`, so it also appears under Plugins → Discover → Unofficial.

### From a local checkout

```sh
git clone https://github.com/ara-hwang/magpie-deeprelay.git
magpie plugin add ./magpie-deeprelay
magpie plugin login deeprelay
```

A folder plugin is loaded where it is, not copied. Moving the folder means adding it again.

### OpenCode

The package follows OpenCode's provider plugin shape. After installing it from npm, add it to `opencode.json`:

```json
{
  "plugin": ["magpie-deeprelay"]
}
```

Then sign in with `opencode auth login`.

## Use

```sh
magpie models deeprelay          # models this account can use
magpie quota deeprelay           # usage and balance
magpie quota deeprelay --json    # machine-readable
magpie provider test deeprelay   # check the request path
```

Agents name a model as `deeprelay/<model>`:

```sh
magpie claude deeprelay/deepseek-v4.1-flash
magpie codex deeprelay/glm-5.3
```

## Models

The live `/v1/models` response is authoritative. The built-in seed covers the current chat catalogue and supplies names and context limits before the first fetch:

DeepSeek V4 Pro, DeepSeek V4.1 Flash, GLM 5.2, GLM 5.3, GLM 5.3 Flash, GPT-OSS 120B, Kimi K3, Kimi K3.1 Pro, MiniMax M3.1 Flash, Muse Glimmer 30B, Muse Spark Open 816B A42B, Qwen3.5 9B, Qwen3.6 Plus, Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 Flash and Qwen3.8 Max.

Image and video models are not exposed as chat models. Deeprelay's chat endpoint is what magpie's agents use.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DEEPRELAY_API_BASE` | Overrides the API base URL. Default: `https://api.deeprelay.ai/v1`. Useful for a proxy or a test server. |
| `DEEPRELAY_API_KEY` | Not read by this plugin. magpie uses the key saved by `magpie plugin login`. |

## Security

- magpie keeps the API key in `plugin-auth.json` (mode 600). The plugin never logs it or writes it to a project file.
- Usage reads only call the documented `billing:read` endpoints.
- Inference requests go only to `api.deeprelay.ai` unless `DEEPRELAY_API_BASE` changes the host.

## Development

```sh
node --test
node scripts/fake-server.mjs
```

`test/plugin.test.mjs` covers the provider declaration, per-account model listing and fallback, subscription-to-window mapping, wallet balance, missing scope, 401 handling, request signing and the base URL override.

`scripts/fake-server.mjs` is a local stand-in for deeprelay's chat and billing endpoints. It is useful for checking the full flow in an isolated magpie config before using a real key.

## 한국어 요약

deeprelay.ai의 OpenAI 호환 API를 magpie에 연결하는 비공식 플러그인입니다. `billing:read` 권한이 있는 API 키로 로그인하면 월간·주간 토큰 사용량, 비용 상한, 검색 사용량, PAYG 잔액이 `magpie quota deeprelay`와 Providers 화면에 표시됩니다. 설치와 사용법은 위 영문 항목과 같습니다.

## License

MIT
