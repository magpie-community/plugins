# TRAE Private CLI

Use an existing private TRAE CLI login in magpie. This plugin targets deployments
whose CLI sends `Cloud-IDE-JWT` requests to `/api/ide/v2/llm_raw_chat`.
It is separate from [trae](../trae), which uses TRAE's public/SaaS sign-in and
`llm_utils_chat` protocol. This is experimental: the raw-chat protocol has been
tested with one private deployment using CLI `0.201.1-tob-alpha.1`.

## Setup

Log in with your organization's TRAE CLI **on the machine running magpie's plugin
host**, then install and configure this plugin:

```sh
magpie plugin add @magpie-community/opencode-trae-private-auth
magpie plugin options trae-private '{"appId":"YOUR_DEPLOYMENT_APP_ID"}'
magpie plugin login trae-private
magpie provider test trae-private
```

`appId` is the deployment's `x-app-id`, supplied by your administrator or CLI
configuration. There is no built-in application ID, company endpoint or model list.
Until an application ID, endpoint and models are available, the plugin declares no
default models; sign-in explains what is missing.

The default CLI directory is `$TRAE_HOME`, else `~/.trae`. The plugin reads:

- `cli/auth.json`: `trae.access_token`, `expires_at`, user identity and
  `endpoints.api_base_url`.
- `cli/models_cache.json`: the `models` array produced by the CLI. Hidden models,
  models with `supported_in_api: false`, and models with
  `business_metadata.uses_tob_raw_chat_surface: false` are excluded. Wire names come
  from `business_metadata.variants.standard_key`, else `config_name`.

If the CLI directory or endpoint differs, set plugin options:

```sh
magpie plugin options trae-private '{"appId":"YOUR_DEPLOYMENT_APP_ID","baseURL":"https://coding.example.test","traeHome":"/absolute/path/to/trae-home"}'
```

Options replace the previous options object, so keep `appId` when updating it.
`baseURL` overrides the CLI endpoint. It must be HTTPS, with no embedded credentials,
query or fragment; a deployment path prefix and port are supported. The plugin
appends `/api/ide/v2/llm_raw_chat` and refuses redirects. It never sends credentials
to the incoming request URL.

OpenCode accepts the same options in its plugin entry:

```json
{
  "plugin": [["@magpie-community/opencode-trae-private-auth", {
    "appId": "YOUR_DEPLOYMENT_APP_ID",
    "baseURL": "https://coding.example.test"
  }]]
}
```

## Models and CLI headers

Models normally follow the CLI cache. A deployment without that cache can provide
an explicit `models` array in options, replacing discovery:

```json
{
  "appId": "YOUR_DEPLOYMENT_APP_ID",
  "baseURL": "https://coding.example.test",
  "models": [{
    "id": "deployment-model",
    "name": "Deployment Model",
    "wire": "deployment-model-standard",
    "context": 128000,
    "output": 16000,
    "image": false,
    "reasoning": true
  }]
}
```

Only `id` is required for each explicit model. `name` and `wire` default to `id`;
`context` and `output` default to the plugin's `limits` (below). Image input and
reasoning default to false for explicit models. Only configured/discovered models
are accepted for requests. Reasoning text is forwarded; selectable reasoning levels
are not advertised.

A cached model's window is **not** copied straight from `models_cache.json`.
`context_window` there describes the CLI's default `__dev` backend only, which is
much smaller than what the raw-chat endpoint accepts (200000 against roughly one
million in the reference deployment), so copying it makes every agent compact far
too early. A cached model gets, in order of preference:

1. `business_metadata.variants.max_context_window`, when the deployment names a
   `__max` backend;
2. its own `context_window`, when that is larger than the limit below;
3. the `limits.context` below.

Set `limits` when your deployment accepts more or less than the defaults:

```json
{ "appId": "YOUR_DEPLOYMENT_APP_ID", "limits": { "context": 1000000, "output": 64000 } }
```

`context` defaults to 1000000 and `output` to 32000. Both are positive integers;
explicit `models` entries that omit `context` or `output` use them too. The
plugin's own limits win over magpie's per-provider "Context window" and "Max
output" fields in the provider editor, so set the window here, not there.

## The context window switch

The provider editor shows one switch this plugin declares:

**Advertise the deployment's full context window** — on by default. On, models are
reported at the `limits` window (1000000 unless set). Off, each model keeps the
window its own CLI cache declares, and the reference deployment reports 200000 /
184000 again — what agents compacted at before. A deployment that names a `__max`
backend keeps that window either way.

The switch is `auth.options`' `max-context-window`, read through
`input.magpie.option`. magpie rereads it whenever it changes, so turning it takes
effect without restarting magpie.

This is the only setting that fits magpie's provider editor: `auth.options`
carries Off/On switches alone, so the numeric window and output limits stay in
the `limits` plugin option (JSON) rather than in a field.

## Request-body budget

The endpoint's front proxy refuses large request bodies with `413` — a byte
limit, not the model's context. The reference deployment accepted 9.5MB and
refused 10MB. Base64 images inside tool results are resent every turn, so a long
session reaches that wall well before its window is used: a 172k-token session
(a fifth of a 1M window) carried 26.7MB of tool results, 29.8MB of them base64.

Before sending, a body over budget is trimmed in three steps, each only when the
previous one was not enough:

1. older images are dropped, keeping the newest one (usually the one this turn
   is about);
2. the remaining images are dropped too;
3. oversized tool results keep their first `toolResultKeep` characters, with a
   note saying how many were cut.

```json
{ "limits": { "bodyBytes": 9437184, "toolResultKeep": 20000 } }
```

`bodyBytes` defaults to 9MB and `toolResultKeep` to 20000 characters. A
deployment whose proxy allows more can raise them; both are positive integers.

## Usage on the provider card

magpie shows a provider's quota on its card through `auth.usage`, which OpenCode
ignores. A private deployment's quota API is its own, and it is usually **not**
the CLI's credential that can read it: in the reference deployment the quota
APIs answer `{"code":30011,"message":"请先登录"}` to the CLI's `Cloud-IDE-JWT`
and only accept a browser session cookie. So the deployment names its endpoints
and where that cookie lives:

```json
{
  "usage": {
    "cookieFile": "/absolute/path/to/trae-web-cookie",
    "cookieName": "X-Cloudide-Tob-Session",
    "quotaPath": "/trae/gtm/tob/api/v1/config/get_personal_quota",
    "usagePath": "/trae/gtm/tob/api/v1/config/get_user_model_usage"
  }
}
```

`cookieFile` holds the session value, one line. Without `usage`, the card says it
is not configured instead of inventing numbers. An unreadable or expired cookie
says so too, and never marks the account as signed out.

Figures are **currency**, from each model's `total_cost_currency`: the reference
deployment bills in yuan and splits usage into a seat allowance and a
pay-as-you-go one (`user_usage_list[0]` and `[1]`).

Both allowances can be raised or lowered by an administrator at any moment, so
every figure is recomputed from each reply rather than assumed to grow:

- a limit lowered under what is already spent caps at 100% and states how much
  is over, rather than hiding an overdraft behind a bare 100%;
- an allowance set to 0 or removed drops its window, leaving the other alone;
- both removed says so, rather than drawing an empty card that reads as a
  failed read;
- a difference under one cent counts as billing rounding, not an overdraft.

`balance` is what can still be spent: the seat allowance is drawn first, so the
pay-as-you-go remainder counts only once the seat one is gone.

The tested CLI headers default to `x-ide-version-code: 20260206`,
`x-ide-version: 99.99.99`, `version: 0.201.1-tob-alpha.1`, `originator: codex_exec`
and a `codex_exec` user agent. If your deployment requires other versions, add:

```json
{
  "client": {
    "ideVersionCode": "YOUR_IDE_VERSION_CODE",
    "ideVersion": "YOUR_IDE_VERSION",
    "version": "YOUR_CLI_VERSION",
    "userAgent": "YOUR_CLI_USER_AGENT"
  }
}
```

## Credentials and behavior

The CLI owns login and renewal. The plugin never writes CLI files or exchanges
refresh tokens. magpie saves the access token, expiry, vendor user identity,
deployment endpoint and application ID in its sign-in store; the CLI's refresh
token is not copied. Each request rereads the CLI login and uses its current access
token. After expiry, refresh the CLI login; magpie can resume when the updated file
is available. Local logout marks the magpie account as needing sign-in.

A saved magpie account is bound to its CLI user, endpoint and application ID.
Changing any of those requires connecting again in magpie, so an old account
cannot silently send requests as the newly selected CLI user. Each plugin instance
follows one CLI directory and deployment. Run it where those CLI files exist;
installing this plugin on a remote server does not import your laptop's login.

Chat Completions requests are translated to raw chat, with streaming and collected
responses, images, tool history, tool calls and token usage. A forced function
choice sends only that function with `required`. Queue/heartbeat events are
ignored. Upstream errors, content-policy blocks and streams that end without a
completion event are reported as failures. Cancellation closes the upstream.

This plugin does not discover a deployment's application ID, run SSO, renew the
CLI session, or report quota. Those details vary across private deployments.

## Checks

```sh
bun test packages/trae-private
bun scripts/check.mjs trae-private
```

Tests use explicit fixture directories and an injected upstream; they do not read
real login files or contact a deployment.
