# opencode-cloudflare-ai-gateway-auth

English | [简体中文](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.zh-CN.md) | [日本語](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.ja.md)

An [OpenCode](https://opencode.ai) provider plugin that sends your requests through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) and pays for
them with the provider keys stored in your gateway (BYOK), not Cloudflare's Unified
Billing. It also lists the models your gateway can reach. It runs in OpenCode 1.x,
and in [magpie](https://usemagpie.ai) too.

> Not affiliated with or endorsed by Cloudflare.

## Why not OpenCode's built-in Cloudflare AI Gateway?

OpenCode 1.x has a `cloudflare-ai-gateway` provider of its own. As of OpenCode 1.18.35:

| | Built-in provider | This plugin |
|---|---|---|
| Google, DeepSeek and xAI keys stored in your gateway | Not used: these go through Cloudflare's REST API, which serves Google through Vertex AI and DeepSeek through Fireworks | Used, through each vendor's own endpoint on the gateway |
| A vendor with no stored key | Can be billed through Unified Billing | Fails instead (`cf-aig-no-wholesale`), unless you allow it |
| Model list | models.dev's catalog for the provider | Only the vendors your gateway holds a key for, from each vendor's own list |
| BYOK key aliases | No | Yes |

Once installed, the plugin takes over the `cloudflare-ai-gateway` provider, and the
built-in one isn't used.

## What you need

- A Cloudflare AI Gateway with authentication on, and provider keys stored under
  **Provider Keys** (BYOK). Turning on **Require provider credentials** (`byok_only`)
  is recommended.
- A Cloudflare API token with **Account → AI Gateway → Run** and
  **Account → AI Gateway → Read**. REST mode only: also **Workers AI → Read**.
- OpenCode 1.18.35 or a later 1.x. OpenCode 2.x isn't supported: it loads plugins
  differently. Or magpie 0.1.1110 or later ([see below](#using-it-with-magpie)).

## Install

Add the plugin to your `opencode.json` (`~/.config/opencode/opencode.json`, or a
project's own):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cloudflare-ai-gateway-auth"]
}
```

OpenCode installs it from npm the next time it starts. A local copy works too:
`"plugin": ["file:///path/to/folder"]`.

## Sign in

```sh
opencode auth login
```

Pick **Cloudflare AI Gateway**, then answer:

| Field | What to enter |
|---|---|
| Cloudflare account ID | 32 hex characters, from the dashboard's account home |
| AI Gateway ID | Your gateway's name, e.g. `my-gateway` |
| Upstream endpoint | **Native provider endpoints** (recommended) or **Cloudflare REST API** |
| BYOK key alias | Native mode only; leave empty for the `default` key |
| API key | The Cloudflare API token above |

- The TUI's `/connect` asks the same questions but doesn't check the answers as you
  type them: with a mistake, the provider doesn't show up in the model list, and
  `opencode models --print-logs` says what's wrong. Sign in again to fix it.
- OpenCode's web and desktop apps ask only for the key, which isn't enough: sign in
  from the terminal.
- OpenCode keeps one sign-in per provider. Signing in again replaces it, e.g. to
  rotate the token or to switch gateway or mode.
- The plugin owns this provider's `baseURL`: one set for `cloudflare-ai-gateway` in
  your config is replaced.

## Models

Models are named `<vendor>/<model>`; pick them as
`cloudflare-ai-gateway/<vendor>/<model>`, e.g.
`cloudflare-ai-gateway/anthropic/claude-sonnet-5-5` in native mode and
`cloudflare-ai-gateway/anthropic/claude-sonnet-5.5` in REST mode.
`opencode models cloudflare-ai-gateway` lists them.

| Vendor | Prefix | Native mode API | REST mode API |
|---|---|---|---|
| OpenAI | `openai/` | Responses | Responses |
| Anthropic | `anthropic/` | Messages | Messages |
| Google AI Studio | `google/` | Chat Completions | — |
| DeepSeek | `deepseek/` | Chat Completions | — |
| xAI | `xai/` | Chat Completions | — |

REST mode reaches OpenAI and Anthropic only. Over REST, Cloudflare serves Google
models through Vertex AI and DeepSeek through Fireworks, and doesn't use a stored xAI
key, so the keys in your gateway don't serve these three. REST also takes only the IDs in
Cloudflare's [model catalog](https://developers.cloudflare.com/ai/models/), so REST
mode lists only the OpenAI and Anthropic models in that catalog, under the catalog's
IDs. These can differ from the vendor's own: Anthropic models with a minor version,
such as `claude-sonnet-5-5`, are `claude-sonnet-5.5` there. Native mode uses each
vendor's own IDs.

Only vendors your gateway holds a key for are listed. In native mode each vendor's
list comes from the vendor itself, through the gateway; when that fails, from
[models.dev](https://models.dev). In REST mode the list comes from Cloudflare's
catalog page, or from models.dev's copy of the catalog when the page can't be read.
models.dev also supplies context windows, reasoning levels and prices.

## Native vs REST mode

- **Native** sends each vendor's own API to
  `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…`. Nothing is
  translated, so prompt caching, extended thinking and the Responses API reach the
  vendor as they are. Use this unless you need REST; in magpie, it's the mode for
  Claude Code and Codex.
- **REST** sends to `api.cloudflare.com/client/v4/accounts/<account>/ai/v1/…` with
  `cf-aig-gateway-id`. It has no key aliases, and lists only the OpenAI and Anthropic
  models in Cloudflare's catalog, under the catalog's IDs (see above). REST takes an Anthropic system prompt only as one string, so the plugin joins its parts and prompt caching doesn't apply to it.

## Billing safety

Every request carries `cf-aig-no-wholesale: true`, so a vendor without a stored key
fails instead of falling back to Unified Billing. On the native endpoints that is a
400, verified live. In REST mode a gateway without the key answered 402 (code 7007)
and billed nothing, but that check couldn't rule out the account simply having no
Unified Billing credits, so keep **Require provider credentials** on: REST then
answers 403 (code 2049). To allow the fallback, give the plugin an option:

```json
{
  "plugin": [["opencode-cloudflare-ai-gateway-auth", { "allowUnifiedBilling": true }]]
}
```

## Troubleshooting

| You see | Meaning |
|---|---|
| The model list is empty, or the provider is missing | Run `opencode models --print-logs`: the plugin logs why (the token was refused, the sign-in isn't valid, or the gateway holds no keys). OpenCode also keeps its logs in `~/.local/share/opencode/log/` |
| `Plugin requires opencode >=1.18.35 <2` | Your OpenCode is older than 1.18.35, or is 2.x |
| 400 from a model (REST mode: 402 or 403) | The gateway holds no key for that vendor under your alias (native mode: code 2044). A 400 can also be the plugin refusing the request before sending it, e.g. an unknown vendor prefix, a model ID that isn't `<vendor>/<model>`, or Google, DeepSeek or xAI in REST mode; its message says which |
| 404 or 500 from a model in REST mode | Cloudflare's model catalog has no model by that ID (e.g. a vendor's own `claude-sonnet-5-5` for the catalog's `claude-sonnet-5.5`): pick a listed model, or use native mode |
| 401 from a vendor | The vendor refused the key stored in the gateway. If the error carries Cloudflare's code 2009 (native mode) or 10000 (REST mode), it's your API token that was refused: sign in again |
| A model is missing | Its vendor has no key in the gateway, or it isn't a chat model; in REST mode, also any model that isn't in Cloudflare's catalog |

## Using it with magpie

The plugin also runs in [magpie](https://usemagpie.ai) 0.1.1110 or later.

```sh
magpie plugin add opencode-cloudflare-ai-gateway-auth
```

or, in the app, find it under **Plugins → Discover → Unofficial**. To install straight
from GitHub instead: `magpie plugin add github:4sh0u0/opencode-cloudflare-ai-gateway-auth`.
A local copy works too: `magpie plugin add /path/to/folder`, or **Plugins → Add a plugin**
with the folder.

```sh
magpie plugin login cloudflare-ai-gateway
```

The fields are the ones above. Each sign-in is one gateway, key alias and mode, named
`<gateway>[/<alias>] · <account ID's first 8>[ · REST]`. Sign in again for another
one; magpie fails over between them. Failover works between sign-ins of the same
mode: native and REST sign-ins name models differently and REST serves only OpenAI
and Anthropic, so don't pair them. Signing in again with the same gateway, alias
and mode replaces that sign-in, e.g. to rotate the token. The sign-in is kept in
magpie's `plugin-auth.json` (mode 600). When Cloudflare refuses the token, magpie
marks the account and asks you to sign in again.

To allow the Unified Billing fallback in magpie:

```sh
magpie plugin options opencode-cloudflare-ai-gateway-auth '{"allowUnifiedBilling": true}'
```

## Development

```sh
bun test
bun --env-file=.env.local scripts/probe.mjs            # live checks, needs .env.local
scripts/opencode-sandbox.sh native anthropic/<model>   # OpenCode 1.x in a throwaway HOME
scripts/sandbox.sh native anthropic/<model>            # magpie in a throwaway HOME
```

## License

MIT
