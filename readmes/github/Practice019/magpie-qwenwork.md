# opencode-qwenwork-auth — QwenWork (千问办公) for magpie / OpenCode

> **改这个插件前先读 [AGENTS.md](./AGENTS.md)** —— 尤其是「不要重启 magpie」那一条。


[中文说明 / Chinese](README.zh-CN.md)

![Platform](https://img.shields.io/badge/platform-macOS-blue) ![Platform](https://img.shields.io/badge/platform-Windows-blue)

Your QwenWork subscription as an OpenCode provider: signs in through QwenWork's
own device flow and serves its models over QwenWork's own agent endpoint, with
the host agent's tools riding along.

> Unofficial. Not reviewed by magpie. Read the code before installing.
> Verified end to end on macOS against the QwenWork 1.2.5 desktop app.

| Provider id | Service | Models |
|---|---|---|
| `qwenwork` | 千问办公 (`gateway.qwenwork.cn`) | the account's own `qwork` catalog |

The package exports `QwenWorkAuthPlugin`.


```
供应商   qwenwork（模型名 qwenwork/<id>）
```

## Install

From this GitHub repository (recommended):

```sh
magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
magpie plugin login qwenwork
```

`magpie plugin add` accepts any spec bun does: an npm package, a `github:owner/repo`
repository, or a local folder. This repository is meant to be installed by its
`github:` spec — that is what follows the code here and picks up updates.

The plugin has no runtime dependencies of its own. Pick `qwenwork/<model>` for
an agent, e.g. `magpie claude qwenwork/flash`.

- **Already installed from a local folder?** Add the `github:` spec and remove
  the folder one, so magpie tracks the repository instead:
  ```sh
  magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
  magpie plugin rm /path/to/your/local/magpie-plugin-qwenwork
  ```
  The sign-in carries over.
- **Finding it in the app.** The repository is tagged `magpie-plugin`, so magpie
  lists it under Plugins → Discover → *Unofficial* (community plugins, not
  reviewed by magpie). Install it there, or with the command above.

## How it works

Sign-in uses the same PKCE device flow the QwenWork desktop app uses, then
keeps the access token refreshed with its own refresh token. The account is
shown by name, falling back to its id.

Chat is rewritten as QwenWork's own `agent_chat_generation` request — the same
request shape the desktop app's engine and the Qoder client speak:

- The host agent's **tools ride along** in the request, so an OpenCode session
  keeps its full tool loop (read, edit, bash, …) on a `qwenwork` model.
- **Tool calls come back structured**, either as the gateway's native
  `tool_calls` or lifted out of inline `<tool_call>` text — never as markup in
  the answer.
- The host's system messages ride along under a short QwenWork preamble, and
  reasoning, usage and credits map back the way the client shows them.

Verified configuration, read from the desktop app's own bundle:

```text
clientId      e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
web / openapi / api   https://gateway.qwenwork.cn
redirect_uri  qwenwork-cn://
device flow   /device/selectAccounts -> /api/v1/deviceToken/poll
refresh       /api/v1/deviceToken/refresh   (target: "c")
chat          /algo/api/v2/service/pro/sse/agent_chat_generation
models        the "qwork" scene
```

Every value, plus the COSY RSA key, can be overridden through `QWENWORK_*`
environment variables and `defaults.json`.

## Usage

Magpie shows the account's credits beside the provider. They come from the same
`account-context` the sign-in already reads, so no extra request is made:

| Shown | From |
|---|---|
| `额度 · Credits` as a percentage (`used` + `limit: 100`) | `quota.used / quota.total` when `total` is set — a paid plan caps credits |
| `额度 · Credits` as a balance (`balance` + `unit`, no `used`/`limit`) | `quota.remaining` when `total` is null — the free plan has no cap, only a wallet |
| `停用 · 额度耗尽` (`used: 100`) | `quota.exceeded` — the one signal that makes the router skip the account |
| `说明 · 计划 <name>` | `plan.name` |
| reset time | `plan.next_refresh_date`, else `plan.next_due_date`; no `until` at all when both are null |

A refused read (401/403) marks the sign-in lapsed; anything else that cannot be
read becomes one `说明 · 额度不可读（<reason>）` window — never a top-level
`error`, which would replace the whole card. See `qwenworkUsage()` in
`index.mjs`. `magpie quota qwenwork` prints it in the terminal:

```text
qwenwork · 个人免费版 · 七七@example.com  subscription  额度 · Credits 399.94 credits  说明 · 计划 个人免费版
```

## Sign-in

Two ways, both in the "add a provider" sign-in dialog:

| Way | What happens | When |
| --- | --- | --- |
| **Device code** (`Sign in with QwenWork`) | QwenWork's own: show a code, confirm in a browser | Default |
| **Paste an access token** | The token is checked against `account-context` before it is kept | When device code cannot work (poll timeout, vendor outage, redirect failure) |

Either can be switched off in the plugin's settings (`Allow device-code sign-in` /
`Allow pasting an access token`). **Turning both off falls back to device code**, so
the dialog never ends up with no way in.

## Import from a file

The provider editor offers "import accounts from a file". Four shapes are read:

```jsonc
// 1. one object
{ "access": "eyJ...", "accountId": "uuid", "expires": 1797702136000 }

// 2. an array
[ { "access": "eyJ..." }, { "access": "eyJ..." } ]

// 3. a version:1 container
{ "version": 1, "accounts": [ { "access": "eyJ..." } ] }

// 4. NDJSON, one object per line; a bad line drops only itself
{ "access": "eyJ..." }
{ "access": "eyJ..." }
```

- The token may be named `access`, `access_token`, `key` or `token`
- `accountId` comes from `accountId`, then `user.id`, then the JWT's `sub`, then the
  token's first 8 characters — it is never empty
- A seconds-granularity `expires` is multiplied by 1000
- A token already in `plugin-auth.json` is refused, naming the key it is under
- At most 100 accounts per import; the rest are reported as "N not handled", never
  dropped silently

## Notes

- Only the chat completions endpoint is served. A lapsed sign-in is reported
  as such, and an upstream failure is trimmed and token-redacted before it
  reaches the caller.
- **The vendor has no check-in endpoint** (five candidates under
  `/api/v1/adapter/user/` all answered 404 on 2026-11-21, and `account-context`
  carries no check-in field), so this plugin has no `auth.checkin`.
- The provider's icon is the QwenWork app icon, used to identify the product.
- MIT.

## Verify

```sh
node --test        # offline: the usage card's shapes and naming
node check.mjs     # offline, mocked upstream
./live-e2e.sh      # live: models, chat, streaming through the gateway
```

## Files

- `index.mjs` — the provider: configuration, device sign-in, usage.
- `vendor/qoder.mjs` — the adapter shared with the Qoder plugin: sign-in, the
  agent_chat_generation codec, tool-call lifting, usage.
- `defaults.json` — verified desktop configuration.
- `icon.png` — the provider's picture, the QwenWork app icon.
- `check.mjs`, `live-e2e.sh` — the offline and live checks.
- `test/` — the usage card's tests (`node --test`).
