<p align="center"><img src="https://raw.githubusercontent.com/DaBinBinah/cloudbase-bridge/main/docs/images/logo.png" width="110" alt="CloudBase Bridge logo"></p>

# CloudBase Bridge

<p align="center">[English](README.md) | [简体中文](README.zh-CN.md) · **GitHub**: [DaBinBinah/cloudbase-bridge](https://github.com/DaBinBinah/cloudbase-bridge)</p>

Use Tencent CloudBase models in [Magpie](https://usemagpie.ai) as an OpenAI-compatible provider, through an `aiProxy` cloud function you deploy yourself.

> Community project: not affiliated with Magpie or Tencent Cloud, and not reviewed or curated by Magpie.

![Growth-plan gift quota in the CloudBase console: 1B tokens + 100K image generations](docs/images/growth-plan-quota.png)

## Why a cloud function in the middle?

The plugin does not call the `/v1/ai/*` model endpoints directly. It invokes `aiProxy` in your environment, which calls the model with `@cloudbase/node-sdk`. Using the SDK does not change the original caller's eligibility for gift quota.

```
Agent ─► magpie gateway ─► plugin ── POST /v1/functions/aiProxy ──► aiProxy (your env) ── SDK ──► model
```

The function returns one complete result; the plugin reshapes it into OpenAI Chat Completions, and synthesizes SSE locally when the agent asked to stream.

## Models

| Model ID | Context | Image input |
| --- | --- | --- |
| `hy4-flash` | 1M | yes |
| `hy4` | 1M | yes |
| `hy4-preview` | 1M | not in the official list; images are forwarded (retired 2026-12-07, then served as `hy4`) |
| `hy3` | 256K | no |
| `deepseek-v4.1-flash` | 1M | yes |
| `deepseek-v4.1-flash-1017` | 1M | yes |

Image input follows the [official model list](https://docs.cloudbase.net/ai/available-models) and needs aiProxy 1.3.0 or later. Images go in user messages as OpenAI `image_url` parts (an `http(s)` link or a `data:image/...;base64` URL) and count toward the 6 MiB request size.

Availability and billing depend on the environment. Under the [official source restrictions](https://docs.cloudbase.net/ai/ai-inspire-plan-usage-governance), third-party calls from Magpie, including calls via cloud functions, are not eligible for the growth-plan text or image gift quota. They may use a paid plan or fail.

**DSH image generation (off by default, plugin 0.2.9+):** Chat-only users, including those on 0.2.4, don't need to change anything.

1. For image generation only, create a separate event function named `generateImage` in the same environment (Node.js 20, entry point `index.main`, recommended timeout 600 seconds), then upload the [ZIP with dependencies](https://github.com/DaBinBinah/cloudbase-bridge/releases/download/v0.2.10/generateImage-with-deps.zip) and deploy directly. Do **not** overwrite `aiProxy` or change the login's function name.
2. Enable **Image generation** in the Magpie plugin options. In DSH select `cloudbase/hy-image-v3.5-preview` and send a text prompt.
3. From 0.2.10, new DSH web replies show the image inline with an **打开原图** (open original) link. If you still get a bare URL, enable **Always show image previews** in Magpie and save. This requests Markdown for all image clients using that configuration, even without a DSH identifier. It doesn't change chat or previous replies. Leave it off for non-DSH clients expecting a bare HTTPS URL.

**Optional image labeling:** Set `IMAGE_FOOTNOTE_MODE` on `generateImage`: `empty` (default) sends an empty string, `space` sends one space, and `omit` leaves out the field as in 0.2.9. After saving, test with `{"action":"check"}` to read `footnoteMode` without calling the model. In live tests, new originals had a visible AI label with `empty`, but not with `space`. [CloudBase documents custom labels](https://docs.cloudbase.net/ai/image-model/custom-watermark), not a guaranteed opt-out. Follow the [content-labeling terms](https://cloud.tencent.com/document/product/301/97822) when distributing images. No function redeployment is needed for inline previews alone.

Download the image before the link expires. Each prompt requests a new image; history, reference images and tools are not sent. Avoid automatic routing, background tasks and model tests here: each invocation can incur charges.

## What you need

1. A CloudBase environment with access to the model and quota eligible for your call source;
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
- tool calling needs aiProxy 1.1.0 or later — redeploy the function (`tcb fn deploy aiProxy --force`) after upgrading the plugin from 0.2.4 or earlier;
- image input needs aiProxy 1.3.0 or later, on user messages only; `hy3` takes text only, and video / file input is not forwarded;
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
