# magpie-relay-identity

A **provider plugin** for [magpie](https://usemagpie.ai) for relays that only accept a specific coding CLI and otherwise answer `401 unauthorized client detected`. You choose which client identity requests claim, or supply your own headers. **Nothing is spoofed by default.**

> Plugin docs: https://usemagpie.ai/docs/zh/plugins

[中文说明](README.zh-CN.md)

## What it does

Some relays only accept the client fingerprint of an official coding CLI. magpie's default User-Agent (and the headers it forwards for the agent) are rejected:

```json
{"error":{"message":"unauthorized client detected, contact support for assistance …"},"type":"unauthorized_client_error"}
```

This plugin turns such a relay into a magpie provider (id `relay-identity`). You sign in with an API key; every request gets the header set you chose. It is for:

- giving one relay an acceptable client identity without patching magpie or hand-editing `providers.json`;
- trying different identities;
- fully custom headers under your control.

## Risk: read this first

**Pretending to be a vendor's own CLI can violate the relay's or the vendor's terms and get your account banned.** That is the only reason this plugin exists, and the reason it is off by default:

- `identity: "none"` is the default: magpie's own identity, no spoofing;
- `identity: "claude-code"` is **high risk**: it poses as the official Claude CLI — the exact case rejected in review as "cannot accept, ban risk". Choosing it means accepting that risk;
- `codex`, `opencode`, `cline`, `kilo`, `roocode`, `crush` also impersonate another client; they are not "safe options", only risks you and the relay's terms decide;
- `identity: "custom"` is your own headers, your own responsibility.

The plugin **cannot guarantee** it will pass: a relay may also inspect the body, TLS, other headers or account behaviour, and the plugin only sets the listed HTTP headers. It also does **not** hide what it does: the README, the options and the plugin summary all say this is spoofing.

## What it does not solve: cross-resource 400

The cross-resource Responses error (`The requested item was created under a different Azure OpenAI resource`) is **not reliably solved here**, for a structural reason:

- magpie does not keep Responses history for plugin providers (`prevKeeps` returns false for `PluginProvider()`), so the plugin receives the client's original request: `previous_response_id` plus only the new turn (a delta), not the whole conversation;
- to fix it inside the plugin's `fetch`, the plugin would have to keep its own "response id → full history" cache and rewrite the body on a 400;
- that re-serializes the whole JSON (large integers in tool schemas can change), the cache is lost when the plugin host restarts, and it only covers conversations started after the plugin was enabled.

Replaying the whole history belongs to magpie core's `responsesState` (a separate branch). The plugin only handles request identity. If your magpie already has that fix, do not reimplement it here.

## Install

```sh
# load the folder in place; nothing is published
magpie plugin add /path/to/magpie-relay-identity

# the relay and the identity (baseURL is required; identity defaults to none)
# note: use the package name magpie-relay-identity, not the provider id relay-identity
magpie plugin options magpie-relay-identity '{
  "baseURL": "https://relay.example/v1",
  "api": "responses",
  "identity": "none"
}'

magpie plugin login relay-identity
```

`baseURL` is required: the first `plugin add` happens before options exist, so the plugin reports a load error naming the missing `baseURL`; setting the options reloads the host and the provider becomes usable.

Agents then use `relay-identity/<model>`. The model list is fetched from `{baseURL}/models` after sign-in.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `baseURL` | **required** | The relay's API base (no trailing `/` needed) |
| `api` | `responses` | `responses` / `chat` / `anthropic`: picks the AI SDK package and request path |
| `identity` | `none` | `none`, `claude-code`, `codex`, `opencode`, `cline`, `kilo`, `roocode`, `crush`, or `custom` |
| `headers` | `{}` | Extra headers; they override a named identity key by key, and are required for `custom` |
| `models` | fetched | A string array or `{id: display name}`; fallback when the relay has no `/models` |
| `modelsPath` | `/models` | Model-list path |
| `name` / `label` | built in | Provider display name / sign-in key label |

### Identity example

```sh
# no spoofing (default)
magpie plugin options magpie-relay-identity '{"identity":"none"}'

# high risk: pose as Claude Code (possible ban)
magpie plugin options magpie-relay-identity '{"identity":"claude-code"}'

# custom: fully under your control
magpie plugin options magpie-relay-identity '{
  "identity": "custom",
  "headers": {
    "User-Agent": "MyClient/1.0",
    "X-My-Client": "yes"
  }
}'
```

An unknown `identity`, or `custom` without `headers`, fails at load time; it never silently falls back to `none`.

## Identity profiles

| `identity` | Headers sent | Note |
| --- | --- | --- |
| `none` | none extra | default; magpie's own identity |
| `claude-code` | `User-Agent: claude-cli/… (external, cli)`, `x-app: cli` | **high risk** |
| `codex` | `User-Agent: codex_cli_rs/…`, `originator: codex_cli_rs` | impersonation |
| `opencode` | `User-Agent: opencode/latest/…/cli`, `X-Opencode-Client: cli` | impersonation |
| `cline` | Cline's headers (`X-CLIENT-TYPE`, `X-CLIENT-VERSION`, …) | impersonation |
| `kilo` / `roocode` / `crush` | their respective User-Agents | impersonation |
| `custom` | exactly your `headers` | your responsibility |

The version strings are reference values; adjust them when a vendor updates its client.

## Privacy and security boundaries

- No logging, no telemetry, no runtime dependencies; the request content goes only to the `baseURL` you configure (and its same-origin model-list path).
- `baseURL` must be `https` (`http` is allowed only for `localhost` / `127.0.0.1` / `::1`), and must not contain credentials in the URL, a query, or a fragment.
- Redirects are followed only while they stay on the **same origin**; a cross-origin redirect is returned as-is, so the `Authorization` / `x-api-key` / identity headers never go to another host.
- `options.headers` refuses connection-control headers such as `Host`, `Content-Length`, `Connection` and `Cookie`; inbound `cookie`, `host` and `proxy-authorization` are stripped before sending.
- The API key stays in magpie's sign-in store; the plugin reads it per request and never logs it. The model-list request also carries only the key and the identity headers.
- The plugin runs inside magpie's plugin host with host permissions: only install plugin code you trust (true for every magpie plugin).

## Tests

No magpie, Bun or real account needed:

```sh
node --test test/plugin.test.mjs
```

Coverage: config declaration, the three `api` npm choices, identity headers, `custom` overrides, `none` spoofing nothing, unknown identity errors, model-list mapping, and the security boundaries (HTTPS-only baseURL, no credentials/query/fragment, path-only `modelsPath`, refused connection headers, cross-origin redirects not followed while same-origin ones are, inbound browser/proxy credentials dropped).

## Compatibility

Written for magpie's OpenCode v1 plugin interface; it also works in OpenCode (`auth`, `config`, `provider`, `loader` hooks). Verified on a local magpie development build with an isolated `HOME`: `plugin add` loads, `plugin options` changes the provider name and identity, and an invalid `identity` fails at load with a clear error.