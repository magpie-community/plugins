# magpie-cliproxy-usage

Expose cached quota readings from your local [Magpie](https://usemagpie.ai) gateway through a read-only subset of the CLIProxyAPI management API. Clients such as T3 Code can poll Codex, Claude, Antigravity, and Grok (xAI) through one endpoint.

## Install and configure

In Magpie, open **Settings → Plugins → Discover → Unofficial** and install **magpie-cliproxy-usage**. You can also install it from the CLI.

```sh
magpie plugin add github:li-yifei/magpie-cliproxy-usage
```

Open the **CLIProxyAPI Usage** (`CLIProxyAPI 用量接口`) page in Magpie's sidebar for a visual settings form, or open **Settings → Plugins → Installed**, find the plugin, and choose **Options** to edit its JSON directly. Saving retires the current plugin host and applies the new settings. If the previous host still holds the port, the replacement retries until the port becomes free.

```json
{
	"port": 3426,
	"host": "127.0.0.1",
	"includeProviders": [],
	"excludeProviders": [],
	"includeRemote": false,
	"allowNonLoopback": false
}
```

To set options from the CLI, pass the complete JSON object you want to save.

```sh
magpie plugin options magpie-cliproxy-usage '{"port":3426,"excludeProviders":["claude"]}'
```

| Option | Environment variable | Default | Accepted values |
| --- | --- | --- | --- |
| `port` | `MAGPIE_CLIPROXY_USAGE_PORT` | `3426` | An integer or a string of decimal digits from 1 through 65535. |
| `host` | `MAGPIE_CLIPROXY_USAGE_HOST` | `127.0.0.1` | A non-empty bind address. By default it must be an IPv4 loopback address, `::1`, or `localhost`, which binds to `127.0.0.1`. |
| `managementKey` | `MAGPIE_CLIPROXY_MANAGEMENT_KEY` | Key from disk or generated on first use | A non-empty string of visible ASCII characters. Leading and trailing whitespace is trimmed. |
| `includeProviders` | — | `[]` | An array of provider IDs, provider names without their remote prefix, or CLIProxyAPI provider types. An empty array allows all supported providers subject to the remote and exclusion rules. |
| `excludeProviders` | — | `[]` | An array of provider IDs, provider names without their remote prefix, or CLIProxyAPI provider types. Exclusions take precedence over includes. |
| `includeRemote` | — | `false` | A JSON boolean. With `false`, each allowed remote provider must appear by its full ID in `includeProviders`. |
| `allowNonLoopback` | — | `false` | A JSON boolean. Set to `true` to allow a bind outside loopback. |

Options take precedence over environment variables. The port and key also accept the legacy variables `MAGPIE_T3_USAGE_PORT` and `MAGPIE_T3_MANAGEMENT_KEY` after their current counterparts.

Provider filters ignore case and surrounding whitespace. With `includeRemote: false`, `["codex"]` includes local Codex and `["s2a/codex"]` includes just that remote Codex provider. With `includeRemote: true`, a non-empty include list still applies. The authenticated `/v0/management/providers` endpoint lists discovered IDs and shows which ones produced a pollable entry.

## Connect a client

Set the client's base URL to `http://127.0.0.1:3426` or your configured address and port. For IPv6 loopback, use `http://[::1]:3426`. Set the management key to the value supplied in the options or environment, or read it from the Magpie config directory.

The config directory is `$XDG_CONFIG_HOME/magpie` when set and `~/.config/magpie` otherwise. The plugin uses `cliproxy-usage-management.key` when present. If that file is absent, it checks `t3-usage-management.key` for an existing key. If neither supplies a key, or if the primary file is empty, the plugin generates a new primary key. Key files used by the plugin have mode `0600`.

Each request requires `Authorization: Bearer <key>` or `X-Management-Key: <key>`. The server uses plain HTTP. A non-loopback bind can expose the key, account labels, and quota data to the network. Keep loopback enabled unless access is restricted and the connection is protected, for example by a TLS reverse proxy.

## Supported management API

All routes are under `/v0/management/`.

| Route | Result |
| --- | --- |
| `GET auth-files` | Synthetic auth-file entries for supported providers with readable quota data. |
| `GET providers` | Discovered provider IDs, remote status, account count, quota availability, and whether an auth-file entry exists. |
| `POST api-call` | Local responses for the operations below. Send a JSON body of at most 16 KiB with `auth_index`, `authIndex`, or `AuthIndex`, plus `method` and `url`. The response envelope contains `status_code`, `header`, and a JSON-encoded `body`. |
| `GET auth-files/models` | HTTP 501. Per-account model routing is unavailable. |

| Provider | Supported `api-call` operations |
| --- | --- |
| Codex (`codex`) | `GET https://chatgpt.com/backend-api/wham/usage` for 5-hour and weekly quota. The `rate-limit-reset-credits` lookup returns HTTP 501. |
| Claude (`claude`) | `GET https://api.anthropic.com/api/oauth/usage` for 5-hour, 7-day, and weekly model-scoped quota. |
| Antigravity (`antigravity`, `agy-cli`) | `POST` to a path ending in `:retrieveUserQuotaSummary` for pool quotas or `:fetchAvailableModels` for per-model quotas. Each operation returns HTTP 501 if its data is absent. The Google user-info lookup reports unavailable. |
| Grok (`grok`, `xai`) | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` for the current subscription allowance. |

The bridge averages each quota window across the accounts that report it, using one reading per account. It reports a shared reset only when every contributing account agrees. Remote account IDs are opaque. Clients should use the `auth_index` returned by `auth-files`. The `method` field is case-insensitive.

The bridge caches successful gateway reads for 15 seconds and failures for 3 seconds. An `api-call` URL selects a local translation. The bridge sends no vendor requests and performs no account changes.

## License

MIT
