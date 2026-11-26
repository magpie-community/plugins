# Clixad

[Clixad](https://clixad.onrender.com) in [magpie](https://usemagpie.ai) and
[OpenCode](https://opencode.ai): all 15 Clixad models through one
OpenAI-compatible gateway, with your own Clixad account paying for it — the
daily free allowance first, credits after.

**Provider id:** `clixad`

## Install

```sh
magpie plugin add @magpie-community/opencode-clixad-auth
magpie plugin login clixad      # pick「从本机 Clixad CLI 导入」
magpie provider test clixad
```

Agents then reach the models as `clixad/<model>`:

```sh
magpie codex clixad/deepseek-v4.1-flash
```

In OpenCode, add `@magpie-community/opencode-clixad-auth` under `plugin`
and sign in with `opencode auth login`.

## Sign-in

Both methods read the Clixad account's own token. Nothing is created and no
Clixad file is modified.

| Method | What it does |
| --- | --- |
| **从本机 Clixad CLI 导入** | Reads `~/.clixad/config.json` exactly as it is, takes its `token`, `login`/`email` and `tokenGateway`, and checks the token against `/v1/wallet` before keeping it. |
| **粘贴 Clixad token** | Asks for the `adg_…` token from that same file. Useful on another machine, or for a second account. Also checked against `/v1/wallet`. |

The token is stored as the provider's key in magpie's `plugin-auth.json` or
OpenCode's `auth.json`, with the gateway URL in the account's metadata.

Clixad tokens are long-lived and Clixad publishes no refresh endpoint, so
there is no `auth.refresh`. If a token is revoked, sign in again with
`magpie plugin login clixad`.

## Models

Before anyone signs in the plugin lists Clixad's 15 models as a static
catalog. After sign-in `provider.models` reads the account's own list from
`/v1/models`; a model Clixad adds, drops or changes (context window,
reasoning levels, free flag) shows up at the next listing. If the read
fails, the previous list stays.

`free: true` marks the models the daily free allowance covers. The rest
spend the account's credits.

## Usage

`/v1/wallet` becomes the Usage card in magpie:

- **今日免费额度** — credits used of the day's allowance (`daily_credits` +
  `extra_credits`), resetting at 00:00 UTC, plus the models it covers.
- the wallet's credit **balance**.

No request counts or per-model spend is invented: Clixad reports the
wallet, and that is all the card shows.

## Requests

Everything goes to `https://clixad.onrender.com/v1` (or the gateway URL the
CLI config names) on the OpenAI Chat Completions API. The loader sets the
`Authorization: Bearer` header on every request, so streaming, tool calls
and reasoning levels all pass through unchanged.

## Development

```sh
node --test                      # this package's tests
bun scripts/check.mjs clixad     # in a magpie-community/plugins checkout
```

MIT. Unofficial; not affiliated with Clixad.
