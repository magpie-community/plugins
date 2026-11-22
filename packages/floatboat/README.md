# Floatboat

Floatboat's models in magpie and OpenCode — the New API gateway behind the
Floatboat desktop app, reached the way the app reaches it.

Floatboat doesn't make models of its own. It is an Electron agent client whose
models all go through `https://newapi.aoe.chat` (a New API instance), and whose
account, credits and `sk-` gateway key live at `https://floatboat.ai`. This
package signs in to the account as the app does, exchanges the session for that
`sk-` key, and forwards chat through the gateway:

```
magpie ──► plugin ──► newapi.aoe.chat/v1/chat/completions   (models)
             │
             └───► floatboat.ai/api/desktop/*               (sign-in / credits / sk- key)
```

It passes no system prompt of its own: the system is the one magpie or
OpenCode sends.

## Install

```sh
magpie plugin add @magpie-community/opencode-floatboat-auth
magpie plugin login floatboat
```

OpenCode, in `opencode.json`:

```json
{ "plugin": ["@magpie-community/opencode-floatboat-auth"] }
```

then `opencode auth login`.

## Sign in

The plugin opens `https://floatboat.ai/desktop-sign-in?state=<uuid>`, lets the
user sign in normally in a one-off Chromium profile, and catches the
`aoe://…?code=…&state=…` deep link the web page redirects to, without letting
it reach the installed Floatboat client. It then exchanges the code at
`POST /api/desktop/auth/exchange`, reads `GET /api/desktop/user/me`, and asks
`POST /api/desktop/newapi/key` for the gateway key.

Three methods, offered in the app and on the terminal:

| Method | When |
|---|---|
| Browser sign-in (default) | The plugin starts a one-off Chromium profile and catches the deep link itself |
| Paste the callback link or code | The browser is blocked, or the user already signed in elsewhere |
| Paste an access token | Fallback; there is no refresh credential, so it must be pasted again when it expires |

`refresh_token` is renewed a little before it expires, and the `sk-` key is
fetched again after a renewal.

## Models

Thirteen ids, exactly those in the client's own model picker:
`lite`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `gemini-3.8-flash`,
`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-carbon`,
`gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.2-astra`, `gpt-6-astra`,
`claude-sonnet-5.5`.

The ids and the `x…` multipliers are upstream facts. The context and output
limits are estimates: the gateway has `/v1/models` switched off (`404
feature_not_supported`), so they are per family and conservative. Vision is
marked per family (Gemini, GPT and Claude models carry image input; DeepSeek and
`lite` don't).

A few ids are Pro-only; the upstream answers "exclusive to Pro" rather than
serving them.

## Credits

Every request that reaches a model costs credits — there is no free lane. The
usage card is a wallet (a balance in credits, no percentage). The two signup
bonuses (200, then 300) are claimed automatically: the plugin asks once, and if
the second isn't open yet it schedules the claim for when it is. `inactive`
means the endpoint is gone or the bonus is no longer available.

## Known limits

- The catalogue can't be fetched from upstream; a new model means editing
  `src/models.mjs`.
- The `sk-` key can rotate: it is cached for 30 minutes, and a 401 makes the
  plugin fetch it once more before it marks the sign-in expired.
- The pasted-access-token method has no renewal.
- The browser sign-in needs a Chromium-based browser (Chrome, Edge, 360, QQ,
  Brave); without one, paste the callback instead.
- Windows, macOS and Linux are covered by the browser detection, but the
  upstream author tested Windows only.

## Source

Vendored unchanged from [`baijiu666//magpie-Floatboat`](https://github.com/baijiu666//magpie-Floatboat)
v0.1.5 (MIT, Copyright (c) 2026 baijiu), with only `package.json` metadata and
this README changed. It is here because that plugin is installed from GitHub
and has no npm package, so magpie's registry has nothing to point at. Pull
upstream changes by copying `index.mjs` and `src/` again and bumping the
version.

MIT — see [LICENSE](./LICENSE).
