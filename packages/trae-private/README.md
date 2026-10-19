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
`context` and `output` default to 200000 and 32000 tokens. Set the limits for your
deployment. Image input and reasoning default to false for explicit models.
Cached models use `context_window` and `input_modalities` with the same default
limits. Only configured/discovered models are accepted for requests. Reasoning
text is forwarded; selectable reasoning levels are not advertised.

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
