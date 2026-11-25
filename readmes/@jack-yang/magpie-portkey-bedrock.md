# magpie-portkey-bedrock

A [magpie](https://github.com/yetone/magpie) provider for AWS Bedrock models through [Portkey](https://portkey.ai). It runs the real [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock) transport (native Bedrock Converse protocol) and works in both magpie (via magpie's pi package bridge) and [pi](https://github.com/earendil-works/pi).

The provider id is **`portkey-bedrock`**. Its models are available to every agent connected to magpie.

中文文档：[README.zh-CN.md](./README.zh-CN.md)

> [!IMPORTANT]
> **Upgrading from 1.2.x or earlier: sign in your accounts again.** Each account now carries its own gateway, route and name from the sign-in form; config files no longer route anything.
>
> 1. **Sign out every existing Portkey Bedrock account** (Providers → Portkey Bedrock). Accounts from earlier versions hold only a key and no gateway, so their requests fail with `Provider is not configured`. Nothing is sent with them, so their keys never leave your machine.
> 2. **Sign in again through the form**: base URL, provider slug, API key and an optional name.
> 3. **Delete `config.local.json`** beside `index.ts` if all it holds is `baseUrl` and `provider`. They are ignored now; only `configId` and extra `headers` still apply (see [Configure your gateway](#configure-your-gateway)).

## Features

- Native Bedrock Converse streaming through `@ai-sdk/amazon-bedrock`.
- GUI sign-in form: **base URL, Portkey provider slug, API key** and an optional account name — no config editing, no browser. Every account routes through its own gateway.
- Multi-account: each signed-in account carries its own key, gateway URL and provider route; magpie rotates, fails over and rate-limits them per account.
- Dynamic model discovery: once an account is signed in, the provider asks that account's gateway for its model list (`GET /v1/models`) and merges what it actually serves into the catalog; failures keep the catalog.
- Text, vision, streamed tool arguments and tool results, including image results and failed tools. Tool arguments parse incrementally — linear in stream length, not quadratic.
- Reasoning levels, including `xhigh` and `max` where declared; signed and redacted reasoning survives replay. Thinking streams with `display: summarized`, so the first token arrives while the model reasons instead of after the whole reasoning pass.
- Prompt-cache checkpoints gated by model family (Claude and Nova only — other Bedrock families ignore or reject `cachePoint`) with `cacheRetention` support, including Bedrock's one-hour TTL (`long`).
- Input, output, cache-read and cache-write token accounting with catalog prices.
- Cancellation, request timeouts, payload inspection and response hooks.
- HTTP status and retry headers forwarded to magpie for its routing and failover logic.
- When Portkey refuses a request, the error says why in its own words (a budget exhausted, a key without the scope, an AWS principal missing an IAM action) and carries Portkey's trace id for the request.

## Install in magpie

```sh
# npm (after publishing)
magpie plugin add @jack-yang/magpie-portkey-bedrock

# or GitHub
magpie plugin add github:yangwudong/magpie-portkey-bedrock

# or a local checkout
git clone https://github.com/yangwudong/magpie-portkey-bedrock.git
magpie plugin add "$PWD/magpie-portkey-bedrock"
```

Then sign in with your **Portkey gateway account** (the Providers page, or `magpie plugin login portkey-bedrock`). The sign-in form asks its fields one after another and saves the account after the last — no browser, nothing else to confirm:

1. **Base URL** — your Portkey gateway's Bedrock-compatible base URL. Requests go to `/model/{encoded model id}/converse-stream`.
2. **Provider slug** — the `x-portkey-provider` route for this account, such as `@your-aws-provider`.
3. **API key** — the account's Portkey gateway key.
4. **Account name** (optional) — what magpie lists the account as. Left empty, it is named by both ends of its key, like `API key AbCd…Yz12`; the rest of the key is never shown.

Names identify accounts: signing in again under a name an account already has updates that account (new key, gateway or route) instead of adding another. Give each account its own name.

An empty base URL or slug means Portkey's public default shown as the field's hint (`https://api.portkey.ai/v1`, `aws-bedrock`); the hints never show your own configuration. magpie keeps each sign-in in `plugin-auth.json` under its configuration directory. Sign in again for each further account: every account keeps its own key, gateway and provider route, and magpie's routing, failover and account limits apply per account. Requests send the selected account's key as both `Authorization: Bearer …` and `x-portkey-api-key`.

Select **Providers → Portkey Bedrock**, then choose a `portkey-bedrock/…` model for your agent:

```sh
magpie claude portkey-bedrock/us.anthropic.claude-opus-5-5
```

magpie installs Bun, the plugin's runtime dependencies and its pi runtime when needed. To reload edits in the app, turn the plugin off and on in Plugins.

## Configure your gateway

There is nothing to configure: every account's gateway and route come from its sign-in, and the package ships no config file.

### The switches

Three settings apply to every account, each set in two places: a value set in magpie's **Options** wins over the config file, which wins over the default. `log` and `cacheTtl1h` are off by default; `retry` is `2`. Why each is what it is, with the Portkey behaviour behind it, is in [docs/portkey-reference.md](docs/portkey-reference.md).

**In magpie: Plugins → the Portkey Bedrock row → Options.** A JSON box opens with the three switches; edit and save, and magpie restarts the plugin. There is nothing to open and no path to find.

**In the config file**, for plain pi or by hand: `~/.config/magpie/portkey-bedrock/config.json`. It lives outside the installed plugin, so updates leave it alone. A `config.local.json` beside `index.ts` from earlier versions is still read while the new file does not exist; move it over, since plugin updates may remove it:

```json
{
  "configId": "pc-your-config",
  "log": false,
  "retry": 2,
  "cacheTtl1h": false,
  "headers": { "x-portkey-trace-id": "magpie" }
}
```

- `log`: whether Portkey may store the content of requests and responses in its logs. **Off by default.** Off, every request carries `x-portkey-debug: false` (Portkey's "DO NOT TRACK"): the gateway keeps tokens, cost and latency, but neither your prompts nor the responses. On, Portkey stores full request and response content. A `x-portkey-debug` header of your own in `headers` takes precedence over the switch.

  > [!NOTE]
  > Portkey documents this header for its `/v1/chat/completions` route, and this provider sends it the same way on `/model/{id}/converse-stream`. Whether the managed gateway honours it there is not documented: check a request in Portkey's Logs page after enabling the provider, and turn `log` on only if you are fine with full content being stored. The switch never removes usage records (tokens, cost, latency), only the request and response content.
- `retry`: how many more times **Portkey's gateway** asks the same account when Bedrock answers `429` or a `5xx`, from `0` to `5`. **`2` by default.** The retry stays on the account, so its prompt cache is kept; when magpie fails over to another account instead, that account starts with no cache and pays to write it again. It costs up to 3 seconds of waiting on a request that keeps failing (Portkey waits 1s, then 2s), and less when Bedrock says how long to wait: Portkey follows Bedrock's `Retry-After`, and gives up at once rather than wait a minute or more. Set `0` to hand every failure to magpie at once. Only `429` and `5xx` are retried; anything else (`400`, `403`, `412`) goes straight back. It is sent as an inline `x-portkey-config`, so it gives way when a `configId` is set or the header is in `headers`: put `retry` in that saved config instead.
- `cacheTtl1h`: keep Claude prompt-cache checkpoints for **one hour** instead of Bedrock's five-minute default, so a conversation you come back to still reads its cache. Off by default; Claude only (Nova caches on its own, for five minutes). Portkey documents the one-hour TTL for Claude Opus 4.5, Sonnet 4.5 and Haiku 4.5; whether your Bedrock models accept it is for you to confirm, as the catalog also lists later ones Portkey's table does not. A caller's own `cacheRetention` still stands: `none` sends no checkpoint and `long` asks for the hour whatever the switch says.

The rest of the file:

- `configId`: an `x-portkey-config` configuration id sent with every account's requests.
- `headers`: additional non-secret gateway headers sent with every account's requests.
- `models`: extra models that the gateway's `/models` list hides but that can be called by id (e.g. `["us.anthropic.claude-fable-5-2"]`). Same entry format as `models.json`; they are always registered, and an entry overrides a catalog model with the same id.

A switch misspelt in magpie's Options (`logs` for `log`) is refused rather than ignored, and the reason goes to magpie's log; otherwise a switch you believe off would stay as it was. A name that is not a switch is fine in the config file, which holds more than switches.

`baseUrl` and `provider` from earlier versions' files are ignored — they route nothing now. Credentials belong in magpie's sign-in, never in this file: the reader rejects API keys and secret headers (`apiKey`, `virtualKey`, `authorization`, `*-api-key`, `token`, `secret`, `cookie`). Restart the plugin after changing it.

Each model entry is checked when the plugin starts: an unknown field (e.g. `contextwindow`) or a wrong type is reported with the entry it is in. A file that cannot be read this way is set aside, not fatal: the provider still loads with the built-in catalog, and the reason goes to magpie's log.

Requests are sent uncompressed. Portkey's deployed gateway reads the body as plain JSON and does not decompress: a gzip or deflate body answers `400` with `Value null at 'messages'` even at 95 bytes, on both `/model/{id}/converse-stream` and `/v1/messages`. Compressing the request needs the gateway to enable request decompression first. Responses are also sent uncompressed, and `Accept-Encoding: gzip, br` changes nothing.

## Models

`models.json` is an editable catalog. Entries may be model ID strings or objects with `id`, `name`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens` and `cost`. Prices are USD per million tokens, with separate `input`, `output`, `cacheRead` and `cacheWrite` values. Fields an entry leaves out take per-family defaults: Anthropic and Nova Pro / Premier ids get reasoning, image input, a 1M context and 64K output; other families get text only, no reasoning, 200K context and 8K output. Prices default to 0.

The included catalog covers the current Bedrock line-up plus common Amazon / DeepSeek / Meta / Mistral models. Availability, limits and prices depend on your AWS account and Portkey route; update the catalog to match them. When an account is signed in, magpie refreshes the list through the provider's `refreshModels`: the gateway's `/models` response is merged with the catalog — catalog entries keep their metadata, unknown ids are added with conservative defaults. The catalog's `name` is what magpie's model picker displays (e.g. `Claude Opus 5.5` instead of the raw Bedrock id); the id remains what requests use.

When the gateway will not list its models, the catalog stays and the reason goes to magpie's log rather than failing the refresh:

- Portkey's own refusal (for example `403` with `Error Code: 033`): the API key may not have the scope to list models (`completions.write`), or the provider slug may belong to another workspace.
- An AWS refusal naming an IAM action (for example `bedrock:ListFoundationModels`): the AWS principal behind the route is not allowed that action. Chat is unaffected; either allow the action in AWS or list the models by hand in `config.json` (see `models` above).

Any other failure (a `5xx`, a body that is no error the gateway owns) is reported with its status and what the gateway said, and nothing more: there is nothing in it you could act on.

| Name | Model id | Context | Max output |
| --- | --- | ---: | ---: |
| Claude Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200,000 | 64,000 |
| Claude Opus 4.8 | `us.anthropic.claude-opus-4-8` | 1,000,000 | 64,000 |
| Claude Opus 5 | `us.anthropic.claude-opus-5` | 1,000,000 | 64,000 |
| Claude Opus 5.5 | `us.anthropic.claude-opus-5-5` | 1,000,000 | 128,000 |
| Claude Sonnet 5 | `us.anthropic.claude-sonnet-5` | 1,000,000 | 64,000 |
| Claude Sonnet 5.5 | `us.anthropic.claude-sonnet-5-5` | 1,000,000 | 128,000 |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | 200,000 | 64,000 |
| Claude 3.5 Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` | 200,000 | 8,192 |
| Nova Premier | `amazon.nova-premier-v1:0` | 1,000,000 | 32,000 |
| Nova Pro | `amazon.nova-pro-v1:0` | 300,000 | 6,400 |
| Nova Lite | `amazon.nova-lite-v1:0` | 300,000 | 6,400 |
| Nova Micro | `amazon.nova-micro-v1:0` | 128,000 | 4,096 |
| DeepSeek R1 | `deepseek.r1-v1:0` | 128,000 | 8,192 |
| Llama 3.3 70B | `meta.llama3-3-70b-instruct-v1:0` | 128,000 | 8,192 |
| Pixtral Large | `mistral.pixtral-large-2502-v1:0` | 128,000 | 8,192 |

## Use in pi

From a local checkout:

```sh
pi -e ./index.ts
```

Use `/login` for `portkey-bedrock`: pi asks the same four fields. Enable only one copy of this provider per session.

## OpenCode plugin vs pi extension

This package is a **pi extension**: the real `@ai-sdk/amazon-bedrock` SDK runs here and speaks native Bedrock Converse, which is what enables the prompt-cache checkpoints, reasoning-effort mapping and signed-thinking replay above. A lighter alternative is an OpenCode provider plugin (magpie's gateway converts to chat completions and a tiny `fetch` adds the gateway headers) — simpler, but generic chat-completions traffic cannot carry Bedrock-specific features like explicit cache points. The two approaches use different provider ids and can be installed side by side.

## Development and verification

Tested with pi 1.5.2 and magpie's Bun plugin host.

```sh
bun install --ignore-scripts
bun run check   # typecheck + tests
```

Tests use real AWS event-stream frames against the Bedrock SDK to verify authentication, conversion, tools, images, reasoning, cache markers, usage, Unicode chunk boundaries, aborts and failures. No live credentials are used.

For integration coverage:

```sh
git clone --depth 1 https://github.com/yetone/magpie.git /tmp/magpie
MAGPIE_SOURCE_DIR=/tmp/magpie bun test test/magpie.test.ts
```

This starts magpie's actual `internal/plugin/host.js` under Bun in a temporary configuration directory and sends Anthropic requests through the pi bridge. Without `MAGPIE_SOURCE_DIR`, that integration test is skipped. Live Portkey access is not part of the automated tests.

`npm publish` creates an installable archive containing the provider, catalog and documentation. Dependencies, tests and local overrides are excluded.

## Marketplace

Tag the repository `magpie-plugin` for automatic discovery under **Plugins → Discover → Unofficial, on GitHub**. For the curated list, PR an entry into [magpie-community/plugins](https://github.com/magpie-community/plugins)' `registry.json` after publishing to npm:

```json
{
  "package": "@jack-yang/magpie-portkey-bedrock",
  "name": "Portkey Bedrock",
  "providers": ["portkey-bedrock"],
  "summary": {
    "en": "AWS Bedrock through Portkey, with tools, vision, reasoning, prompt caching and dynamic model discovery.",
    "zh": "通过 Portkey 使用 AWS Bedrock，支持工具调用、图像、推理、提示词缓存与动态模型发现。"
  }
}
```

## Credits

Configuration layering, secret hygiene and the streaming core are based on [TianZuo555/magpie-portkey](https://github.com/TianZuo555/magpie-portkey) (MIT). This package uses a different provider id (`portkey-bedrock`), so the two can be installed side by side.

## License

MIT
