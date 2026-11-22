---
name: magpie-floatboat
description: Install and sign in to the Floatboat provider in magpie (usemagpie.ai) — the models behind the Floatboat desktop app, with its credit balance and the new-account bonus claim. Use when the user asks to add Floatboat, to reach Floatboat's models from an agent, or when a `floatboat/*` model is missing or the provider shows as not signed in.
---

# magpie floatboat

Floatboat's desktop app doesn't make models itself. It is an Electron agent
client whose models all go through `https://newapi.aoe.chat` (a New API
instance), and whose account, credits and `sk-` gateway key live at
`https://floatboat.ai`. The `magpie-Floatboat` plugin signs in the way the
app does, exchanges the session for that `sk-` key, and serves the 13 model
ids as `floatboat/<id>` to every agent magpie connects.

```
magpie ──► plugin ──► newapi.aoe.chat/v1/chat/completions   (models)
             │
             └───► floatboat.ai/api/desktop/*               (sign-in / credits / sk- key)
```

It passes no system prompt of its own: the system is the one magpie sends.

## Install

```sh
magpie plugin add github:baijiu666/magpie-Floatboat
magpie plugin list            # floatboat (Floatboat, 13 models)  on
```

Windows, macOS and Linux. The sign-in opens a Chromium-based browser
(Chrome, Edge, 360, QQ, Brave); without one, paste the callback instead.

If the `github:` spec can't be fetched, install from a checkout of the
repository as a folder — a path is loaded where it is, with nothing
installed:

```sh
git clone https://github.com/baijiu666/magpie-Floatboat
magpie plugin add ./magpie-Floatboat
```

A convenience installer that does either step, with an `-Uninstall` /
`--uninstall` switch, is at
[cat-clash/magpie-floatboat-installer](https://github.com/cat-clash/magpie-floatboat-installer).
Prefer the two commands above unless the user asks for it.

## Sign in

```sh
magpie plugin login floatboat
```

Three methods, offered in the app and on the terminal:

| Method | When |
|---|---|
| Browser sign-in (default) | The plugin opens a one-off Chromium profile at `https://floatboat.ai/desktop-sign-in?state=…` and catches the `aoe://…?code=…&state=…` deep link itself, without launching the user's Floatboat client |
| Paste the callback link or code | The browser is blocked, or the user already signed in elsewhere: paste the `aoe://…` line |
| Paste an access token | Fallback. There is no refresh credential, so it has to be pasted again when it expires |

Don't try to register the `aoe://` protocol for the plugin: the installed
Floatboat client already owns it.

## Verify

```sh
magpie plugin list                                   # signed in as <account>
curl -s http://127.0.0.1:3425/v1/models | grep floatboat
```

The second only answers for a signed-in account. If the app isn't running,
`magpie plugin list` still reads what the plugin stored.

## Models

`lite`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `gemini-3.8-flash`,
`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-carbon`,
`gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.2-astra`, `gpt-6-astra`,
`claude-sonnet-5.5`.

Some are Pro-only; the upstream answers "exclusive to Pro" rather than
serving them. The ids and their `x…` multipliers come from the client's own
model picker; the context and output limits are the plugin's estimates,
because the gateway has `/v1/models` switched off (`404
feature_not_supported`). Vision is marked per model family.

## Credits

Every request that reaches a model costs credits — there is no free lane.
The Usage card shows a wallet window (a balance in credits, no percentage),
and the two signup bonuses (200, then 300) are claimed automatically: the
plugin asks once, and if the second isn't open yet it schedules the claim
for when it is. `inactive` means the endpoint is gone or already claimed.

## Don't

- Don't promise a model is free, and don't invent a used percentage: this is
  a wallet, not a quota window.
- Don't retry a Pro-only model as if it were a failure to route; tell the
  user the plan doesn't include it.
- Don't run `magpie plugin add` twice to "refresh" the key — a 401 is
  handled by the plugin, which re-fetches the `sk-` key once.
