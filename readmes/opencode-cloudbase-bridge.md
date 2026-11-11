# CloudBase Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

**GitHub**: [github.com/DaBinBinah/cloudbase-bridge](https://github.com/DaBinBinah/cloudbase-bridge)

Bring the AI quota of Tencent CloudBase's "小程序成长计划" (mini-program growth plan) into [Magpie](https://usemagpie.ai) as an ordinary OpenAI-compatible provider, through an `aiProxy` cloud function you deploy yourself. Once set up, it's just another provider on your account that any agent can use.

> Community project: not affiliated with Magpie or Tencent Cloud, and not reviewed or curated by Magpie.

![Growth-plan gift quota in the CloudBase console: 1B tokens + 100K image generations](docs/images/growth-plan-quota.png)

## Why a cloud function in the middle?

The gift quota only pays out on CloudBase SDK channels — calling the `/v1/ai/*` model endpoints directly is rejected (`403 AI_CHANNEL_NOT_ALLOWED`). So the plugin never talks to those endpoints. It calls your `aiProxy` cloud function through the official function-invocation endpoint, and the function calls the model with `@cloudbase/node-sdk`, which is allowed:

```
Agent ─► magpie gateway ─► plugin ── POST /v1/functions/aiProxy ──► aiProxy (your env) ── SDK ──► model
```

The function returns one complete result; the plugin reshapes it into OpenAI Chat Completions, and synthesizes SSE locally when the agent asked to stream.

## Models

| Model ID | Context |
| --- | --- |
| `hy3` | 256K |
| `hy4` | 1M |
| `hy4-preview` | 1M |
| `deepseek-v4.1-flash` | 1M |
| `deepseek-v4.1-flash-1017` | 1M |

No console opt-in needed; usage is deducted from the gift pack automatically. Availability can vary per environment — if CloudBase answers `AI_MODEL_NOT_SUPPORTED`, go by what your environment actually supports.

## What you need

1. A CloudBase environment with the growth plan (or an active Token Credits pack);
2. the `aiProxy` function deployed in that environment (next section);
3. a server-side API Key, created in the console under Environment settings → API Key.

> The API Key carries full admin rights over the environment. It lives only in Magpie's local auth store (`~/.config/magpie/plugin-auth.json`, mode 600) — don't commit it anywhere or hand it to anyone.

## Deploy aiProxy

Full steps (console upload, CLI, common pitfalls) live in [`cloudfunctions/aiProxy/README.md`](cloudfunctions/aiProxy/README.md). Quick CLI version:

```bash
cp cloudbaserc.example.json cloudbaserc.json   # set envId to yours
tcb login
tcb fn deploy aiProxy --force
tcb fn invoke aiProxy --params '{"action":"ping"}'   # expect {"ok":true,...}
```

Key points: a normal Event Function (not an HTTP function), Nodejs18.15 or newer, timeout 120 s, cloud dependency install enabled. No need to configure the environment id — the runtime injects `TCB_ENV` automatically. To add or remove models, set the function's `AI_PROXY_ALLOWED_MODELS` env var (comma-separated).

## Install & login

```bash
magpie plugin add DaBinBinah/cloudbase-bridge   # or: the npm package opencode-cloudbase-bridge, or ./cloudbase-bridge for a local checkout
magpie plugin login cloudbase
```

Login walks you through the API Key, the environment ID, the region (mainland China / international), and the function name (press Enter to keep `aiProxy`). Models then appear as `cloudbase/hy3`, `cloudbase/hy4-preview`, and so on (if the `cloudbase` id is already taken, Magpie renames the provider to `cloudbase-plugin` — both prefixes work). Which models an account actually gets is decided by your deployed function's allowlist; the plugin queries it after login.

Sign out with `magpie plugin logout cloudbase`.

## Try it in a sandbox first

None of this touches your real magpie config or logins:

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./cloudbase-bridge </dev/null
m plugin login cloudbase
m provider test cloudbase        # or a single model: m provider test cloudbase hy3
```

No CloudBase environment yet? Walk the flow against the bundled mock gateway:

```bash
node scripts/mock-ai-proxy.mjs --port 8787
m plugin options cloudbase-bridge '{"gatewayBaseUrl":"http://127.0.0.1:8787"}'
```

`gatewayBaseUrl` is for testing only — it sends every request, including the API Key header, to that URL. Clear it afterwards with `m plugin options cloudbase-bridge off`.

## Options

| Option | What it does | Default |
| --- | --- | --- |
| `envId` / `region` / `functionName` | fallbacks beyond the login answers (handy under plain OpenCode, where the login prompts may not render) | — / `cn` / `aiProxy` |
| `timeoutMs` | how long one function invocation may take | 150000 |
| `gatewayBaseUrl` | testing-only gateway URL override | unset |

## When something goes wrong

Errors come back as OpenAI-style `{ error: { message, code } }`, and the message usually says what happened. The common ones: `FUNCTIONS_NOT_FOUND` (function not deployed, or wrong environment), `AI_CHANNEL_NOT_ALLOWED` (the function must call the model via the Node SDK), `AI_MODEL_NOT_SUPPORTED` (model not available in your environment), 401 `PERMISSION_DENIED` (wrong or wrong-type API Key), timeouts, and `EXCEED_TOKEN_QUOTA_LIMIT` (quota spent or expired). Fixes for each are in [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Known limitations

- No true streaming: the upstream reply is one-shot, SSE is synthesized locally, so the first token only arrives when generation finishes;
- no tool calling, no image input, and `max_tokens` is ignored (the SDK channel takes `{ model, messages, temperature, topP }` only);
- very long outputs can hit the function's 120 s timeout;
- no quota reporting (no official API for it); the gift quota itself expires (6 months).

## Development

```bash
npm install
npm run check     # typecheck + build + 34 unit tests + host-like load check — no network, no real credentials
```

Publishing and listing steps are in [`docs/publish-checklist.md`](docs/publish-checklist.md).

## License

[MIT](LICENSE)
