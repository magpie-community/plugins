# agnes

Agnes AI ([agnes-ai.com](https://www.agnes-ai.com)) in
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). The plugin
uses Agnes's OpenAI-compatible endpoint at `https://apihub.agnes-ai.com/v1`,
discovers the account's text models, and reads both Token Plan and Agent Plan
usage. Its primary sign-in opens the official Agnes login in a private Chrome
window and finishes without asking for your password or a copied token.

**Provider id:** `agnes`

This package targets the **international site**: `platform.agnes-ai.com` and
`apihub.agnes-ai.com`. The CN site would need its own package and provider id,
for example `agnes-cn`.

## Sign-in

### Browser sign-in

Choose one of the browser sign-in methods:

- **Agnes browser sign-in (plan key)** for a Token Plan or Agent Plan key.
- **Agnes browser sign-in (personal key)** for a `default` profile key.
- **Agnes browser sign-in (enterprise key)** for an `enterprise` profile key.

The plugin starts a separate Chrome, Edge, Chromium or Brave profile, opens
the official Agnes login page, and waits for you to sign in. It then reads the
session through Chrome DevTools Protocol, reveals the selected profile's API
key, and closes the browser window.

The dedicated profile is kept at
`~/.config/magpie/agnes-browser` (`AGNES_PROFILE` overrides it), so the next
sign-in can reuse the login instead of asking again. It is separate from your
everyday browser profile; the plugin does not read your normal cookies, saved
passwords or history. The profile is created with mode `0700`, but it does
contain the Agnes session because Chrome keeps it there.

The API key and console session are also stored in the plugin account. Set
`AGNES_BROWSER` to a Chromium-based browser path if it is outside the usual
locations.

Browser accounts are labeled `Agnes Plan`, `Agnes Personal` or
`Agnes Enterprise`; the account's email or username is not written into
Magpie's plugin auth file.

Personal and enterprise keys are billed from the account balance and can use
the free models enabled for that key. If a profile has more than one active
key, the browser sign-in picks the first active key in the platform's list; use
the API-key fallback if you need a specific key.

This browser path is experimental because it relies on Agnes keeping its
current `localStorage.token` login shape.

### API key fallback

There are two credentials:

- **API key** (for example `cpk-…` for a Token Plan key): used for model
  requests. Create or copy it in the Agnes platform's API key page.
- **Console token** (optional): used only to read plan usage. Sign in at
  [platform.agnes-ai.com](https://platform.agnes-ai.com), then copy
  `localStorage.getItem("token")` from the browser console and paste it into
  the plugin's sign-in prompt.

In the fallback, the API key is stored as the account key and the console token
is stored in `metadata.consoleToken`. The plugin sends the console token only
to `platform-backend.agnes-ai.com`; it never sends it to the model API. A
refused console token does not sign the API key out.

The fallback also asks for the key type, so a manually entered personal or
enterprise key does not request plan quota endpoints.

Treat the console token like a password: it grants access to the Agnes account,
not just to usage.

Agnes currently offers no standard OAuth callback for third-party clients, so
the console token has to be pasted manually. It can expire independently of
the API key; sign in again with a fresh token when that happens.

## Models

After sign-in, `GET /v1/models` supplies the account's live list. Image and
video generation models are left out because this is a chat provider; their
quotas still appear on the usage card.

The bootstrap and documented text models are:

| Model | Context | Max output | Input |
| --- | ---: | ---: | --- |
| `agnes-3.0-flash` | 512K | 65,536 | text, image URL |
| `agnes-2.5-flash` | 512K | 65,536 | text, image URL |
| `agnes-2.5-pro` | 1M | 65,536 | text, image URL |
| `agnes-2.5-pro-beta` | 1M | 65,536 | text, image URL |

All documented models support streaming, tools and reasoning. Prices shown by
magpie use Agnes's published list prices in USD per million tokens. During a
promotion or trial, Agnes may bill less; the platform's usage page remains the
source of truth.

## Usage

The usage card supports both Agnes plans:

- **Token Plan** (`/api/user/subscription`): text requests in the 5-hour and
  weekly windows, daily image count and daily video seconds.
- **Agent Plan** (`/api/user/agentplan/subscription` and `/credits`): monthly
  Credits, the shared 5-hour Credits window and purchased Credits balance.
- **Personal / enterprise keys** (`/api/user/balance`): the available USD
  balance only. Their model calls are billed from that balance.

An account holding both plans sees both sets of windows. The usage endpoints
are Agnes platform interfaces rather than the public inference API, so a
future upstream change may require a plugin update.

Only accounts signed in with a **plan key** query Token Plan/Agent Plan
usage. **Personal** and **enterprise** accounts show only the wallet balance.
Plan-key accounts do not show the wallet balance.

## Install

```sh
magpie plugin add @magpie-community/opencode-agnes-auth
magpie plugin login agnes
magpie provider test agnes
```

In OpenCode, add the package under `plugin` and sign in with
`opencode auth login`.

## Development

```sh
bun test
bun scripts/check.mjs agnes
```

MIT. Not affiliated with Agnes AI.
