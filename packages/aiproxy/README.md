# AI Proxy for Magpie and OpenCode

[简体中文](README.zh-CN.md)

This is an OpenCode provider plugin that Magpie can load natively. It adds an
`aiproxy` provider with:

- OpenAI-compatible model discovery through `{baseURL}/v1/models`;
- model requests authenticated with the AiProxy API key;
- a browser-cookie login path for accounts protected by 2FA or SSO;
- native `magpie quota` reporting for the AiProxy wallet;
- daily, weekly, rolling-window and budget quota windows from
  `/api/v1/user/entitlements`;
- fallback support for older `/api/v1/user/quotas` deployments;
- optional admin upstream windows when the logged-in user has an admin role;
- short in-process quota caching and request de-duplication.

The plugin uses two independent credentials:

- the **API key** is used for model requests;
- the **console email and password** are used to obtain the browser-style
  session cookie needed by AiProxy's user quota endpoints.

The plugin returns the password and session Cookie in the account's auth
metadata; it does not create a separate credential file. Magpie stores this
metadata in `plugin-auth.json` in its configured data directory (normally
`~/.config/magpie/plugin-auth.json`, written with owner-only `0600` permissions
on POSIX). This is a local credential file, not an encrypted vault. For a remote
Magpie, it is on the machine running Magpie, not on the computer displaying
the Web UI. Protect that file and any backups of it.

OpenCode manages the credentials in its own auth storage: the 1.x entry returns
the auth metadata directly; the shared 2.x adapter places it in the saved
credential's `metadata.v1`. Magpie's file path/permission description does not
describe OpenCode's storage.

The Cookie is attached only to `/api/v1` console requests at the user-entered
site. The password is sent only to that site's `/api/v1/auth/login`; neither is
attached to model requests, icon fetches or requests to the plugin author.
Console requests, model-catalog reads and protocol probes all use
`redirect: "error"`: no HTTP redirect is followed, even within the same origin,
so these credentials are not forwarded to a different host, port or scheme.
If a deployment redirects, enter its final canonical Base URL instead.
Cookie login reuses the session you obtained in a browser; it does not automate
SSO redirects. The plugin never prints either credential and strips upstream
error bodies from user-facing errors.

## Install

```sh
magpie plugin add @magpie-community/opencode-aiproxy-auth
magpie plugin login aiproxy
```

For OpenCode, add `@magpie-community/opencode-aiproxy-auth` to the `plugin`
array in `opencode.json`. The package's `main` is the OpenCode 1.x / Magpie
entry; `exports["."]` uses this repository's shared OpenCode 2.x adapter.
The native quota hook and post-login protocol switches are Magpie features.

Choose **AiProxy custom site** and enter the AiProxy base URL first, followed by
the API key, protocol choice and console credentials. The provider is shown as **AI Proxy** in
Magpie; you can set an optional account display name during login, which labels
that account's quota card without changing the provider name.

Public Base URLs must use `https://`. Plain `http://` is accepted only for
localhost, `.local`, loopback and private LAN addresses.

After login, the plugin performs only read-only protocol probes:

- `/v1/models` indicates an OpenAI-compatible provider;
- `/v1/responses` selects the OpenAI Responses SDK when the endpoint exists;
- `/v1/messages` and `/v1beta/models` are recorded as Anthropic and Gemini
  capabilities.

The plugin currently routes model traffic through OpenAI Chat Completions or
OpenAI Responses. It reports Anthropic/Gemini detection for visibility but does
not translate those upstream protocols yet. Choose **Auto** to use the probes,
or explicitly choose Chat Completions / Responses to override them. Probes
never send a prompt or generate model output.

After login, the provider options also expose **Force OpenAI Chat Completions**
and **Force OpenAI Responses** switches. These change the model SDK selection
without asking for the API key or console credentials again. If both switches
are enabled, Responses takes precedence.

If the account requires 2FA or SSO, choose the **browser Cookie** method after
logging into AiProxy in a browser. Copy the Cookie request header from the
authenticated `/api/v1` request and paste it into Magpie. The API key is still
needed for model requests; the Cookie only authorizes console quota reads.

After login:

```sh
magpie quota
magpie quota --json
```

The plugin reads the wallet from `GET /api/v1/user/me`. It then reads the
current plan from `GET /api/v1/user/entitlements`. If that endpoint is absent,
it falls back to `GET /api/v1/user/quotas`.

An admin-role account also gets a best-effort read of
`GET /api/v1/admin/quota`; unavailable or unauthorized admin data is ignored
without hiding the normal user quota card.

## Security and limitations

The plugin only performs read-only quota requests. It does not refresh an
upstream provider account, generate model output during protocol detection,
or change AiProxy routing. Model requests initiated by an agent use the
configured site's API key and may consume quota.
AiProxy's quota model can contain an account wallet, a plan window, a key
budget and a shared source budget. The plugin keeps those windows separate
instead of adding shared limits together.

The plugin is designed for AiProxy deployments that expose the documented
console routes. The browser-cookie method covers deployments where the console
login requires 2FA or SSO. Magpie's provider icon is static for a plugin
provider, so all custom AiProxy hosts use the plugin's generic AiProxy icon.
Per-host favicon selection would require Magpie to add per-account icon
support.

This provider targets the [AiProxy](https://github.com/veildawn/ai-proxy-releases)
console API, not every OpenAI-compatible proxy. It has no default site and
does not bundle a shared account or API key. Ordinary OpenAI-compatible
providers can call models without console credentials; this plugin adds
account wallet and plan quota reads from AiProxy's console endpoints.

This package is adapted from
[violin321/magpie-aiproxy-plugin](https://github.com/violin321/magpie-aiproxy-plugin)
v0.5.0 under its MIT license. The `aiproxy` provider ID is unchanged. It uses
the generic AiProxy icon; per-site favicons are not supported by the host's
static provider icon.

## Validation

Tests use synthetic credentials and do not read a real account. Unit tests
use mocked responses; redirect tests make requests only to local HTTP servers.
Run the package tests and the community hook/registry checks:

```sh
node --test packages/aiproxy/*.test.mjs
bun scripts/check.mjs aiproxy
```

The redirect regression tests use two local HTTP servers and synthetic
credentials to verify that 301/302/303/307/308 responses cannot forward login
credentials, Cookies or API keys, to another origin or within the same origin.
They do not contact a live AiProxy deployment.

The source plugin has been used with a custom AiProxy deployment in Magpie.
That does not establish compatibility with every deployment/version, or live
OpenCode 2.x behavior; the latter is provided by the shared adapter and checked
without signing in.

## Development

```sh
npm test
npm run check
```
