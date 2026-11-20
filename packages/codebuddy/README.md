# @magpie-community/opencode-codebuddy-auth

Serves **Tencent CodeBuddy** (the China build's subscription, served at
`https://copilot.tencent.com`) as a provider in Magpie or OpenCode, signed
in with the **local CodeBuddy desktop login** — no browser, no pasted
token. Where WorkBuddy 5.6 and later seal their desktop sign-in encrypted
(`workbuddy-desktop.info`, which only the app can open), the CodeBuddy
desktop keeps its own login in the clear, and this plugin reads it.

| Provider id | Plan | API |
|---|---|---|
| `codebuddy` | Tencent CodeBuddy | `https://copilot.tencent.com/v2` |

The package exports `CodeBuddyAuthPlugin`.

## Installing

```sh
magpie plugin add @magpie-community/opencode-codebuddy-auth
magpie plugin login codebuddy
```

## Signing in

Open the CodeBuddy desktop and sign in on the same computer first, then
choose **CodeBuddy desktop's sign-in** in the provider's sign-in menu. The
plugin uses the account the desktop is signed in to, from the desktop's
own login files:

- macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`
- Windows: `~/AppData/Local/CodeBuddyExtension/Data/Public/auth/`
- Linux: `~/.local/share/CodeBuddyExtension/Data/Public/auth/`

It reads the files the CodeBuddy desktop writes (`*coding-copilot*.info`,
`*codebuddy*.info`; WorkBuddy's `workbuddy-desktop.info` is skipped — its
tokens are sealed). When several are there, the one whose access token
isn't about to end is used. Nothing is copied, and nothing is written
back: the file is read on each request as the app keeps it, so if the
desktop app renews or changes accounts, the plugin follows. A token
renewed here is held in memory for this run only, so the desktop app is
never signed out of a token it holds.

The account's sign-in is kept as an OpenCode `oauth` marker,
`{"type": "oauth", "source": "desktop", "accountId", "uid"}`; OpenCode
keeps it in `auth.json`, magpie in `plugin-auth.json`.

## Requests

Chats are OpenAI chat completions at `https://copilot.tencent.com/v2`,
with the headers the CodeBuddy desktop's own API calls carry: the access
token (`Authorization: Bearer`), the user id (`X-User-Id`), the domain
(`X-Domain`), and, for an enterprise (team) account, `X-Enterprise-Id` and
`X-Tenant-Id` (both the account's enterprise id — without them the API
answers as the personal account). An enterprise account signed in to the
desktop is asked for as the enterprise.

The access token is refreshed a minute before it ends, once per refresh
token (`POST /v2/plugin/auth/token/refresh`, with `X-Refresh-Token` and
`X-Auth-Refresh-Source: plugin`), and the new one is used and held in
memory. A refresh that fails — a refresh token that has ended included —
leaves the access token there is, and the request goes with it. A 401 says
the sign-in was refused and tells you to open the desktop app again; it
never marks the account expired, because the file is read on each request.

An inference HTTP 401 is passed through as a 401 with the hint; other
statuses pass through unchanged. Network failures retain the underlying
error. No request is retried automatically. `auth.refresh` (magpie's
pre-request renewal, five minutes ahead) only applies to a sign-in whose
tokens the host keeps; a desktop sign-in is always read fresh.

## Models

Until a signed-in account's live list is read — and when it can't be — the
models offered are the CodeBuddy plan's menu on `copilot.tencent.com`:
`auto`, `hy4-preview-f`, `hy3`, `hy3-x`, `deepseek-v4.1-flash`,
`glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5.1`, `glm-5v-turbo`,
`minimax-m3`, `kimi-k3-1`, `kimi-k2.7`, `kimi-k2.6` and
`deepseek-v4-pro`, with their reasoning efforts where the model names any.
An enterprise account's own list replaces it when the backend answers
(`GET /console/enterprises/<id>/config/models`, the config the desktop
reads): the routing aliases (`default`, `fast-model`, …) and the non-chat
models (image, embedding, …) the menu lists are left out, as the desktop's
own client never sends them. A personal account has no such list and keeps
the menu above.

## Notes

These are undocumented desktop interfaces, not a supported public API.
The desktop's login files hold the tokens in the clear (that is what makes
this sign-in possible); the plugin never logs them, and its failure
messages never include a token, uid or file path. The account's own
enterprise models are not queried for a personal account. Usage/check-in
cards are not implemented. Users remain responsible for their
subscription's terms.

```sh
node --test packages/codebuddy
bun scripts/check.mjs codebuddy
```

Tests use synthetic sessions and fake HTTP responses: file discovery and
sealing, expiry selection, refresh merging and one-refresh-at-a-time,
header signing (enterprise included) and model-list filtering. No account,
token or vendor binary is distributed. No runtime dependencies.
