# Freebuff for Magpie

A [Magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) provider that signs in to
[Freebuff](https://freebuff.com) with a **Developer API key** and serves its OpenAI-compatible models.

## What works, and what does not

Freebuff has two separate ways in:

| | Freebuff CLI / Desktop (free tier) | Developer API (this plugin) |
|---|---|---|
| Credential | Session token from the app sign-in | API key from [freebuff.com/account/api](https://freebuff.com/account/api) |
| Intended for | Freebuff's own interactive apps | external tools, scripts, agents |
| Works here | **No** | **Yes** |

Freebuff's free tier is gated on its own attested client: requests from any other program are
refused with `410 freebuff_update_required`, whatever headers or device key they carry. That is by
design, not a bug this plugin can route around. So this plugin will **not** give you the free tier
inside an agent.

What it does do is let you use a Developer API key — the supported way to call Freebuff from
another program — with the model list kept in sync from `GET /api/v1/paid/models`.

If you paste a session token by mistake the plugin says so, locally, instead of failing upstream:

> This is a Freebuff session token (CLI/Desktop sign-in), not a Developer API key. … Create a
> Developer API key at https://freebuff.com/account/api and sign in again.

## Install

```sh
magpie plugin add opencode-freebuff-auth
```

Then sign in:

```sh
magpie plugin login freebuff
```

## Develop

```sh
npm test
```

## Notes

- The real key never rides on `loader.apiKey` (a placeholder goes there, because the host shares
  loader options with other plugins' `chat.headers`); it is injected per request in `fetch`.
- `fetch` refuses any origin other than `freebuff.com`, so a host that hands the loader to another
  plugin cannot leak the key elsewhere.
- A `401` marks the account expired via `X-Magpie-Sign-In: expired`; a `5xx` keeps the curated
  model list instead of emptying the picker.
- The module exports exactly one function. Magpie calls every exported function as a plugin, so a
  second export would initialize the provider twice.

MIT.
