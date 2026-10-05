# @magpie-community/opencode-workbuddy-auth

Signs in to the plans of WorkBuddy, Tencent's desktop agent from CodeBuddy.
It has one provider for each of WorkBuddy's two builds:

| Provider id | Build | API |
|---|---|---|
| `workbuddy` | WorkBuddy, the China build (CodeBuddy plan) | `https://copilot.tencent.com/v2` |
| `workbuddy-ai` | WorkBuddy AI, the international build | `https://www.workbuddy.ai/v2` |

The package exports `WorkBuddyAuthPlugin` (`workbuddy`) and
`WorkBuddyAIAuthPlugin` (`workbuddy-ai`).

## Signing in

- **Account (browser).** Opens Tencent's sign-in page for the build, the
  one WorkBuddy's desktop app opens. The plugin then asks WorkBuddy for the
  token every second until you're signed in, for 5 minutes at most. Nothing
  needs to be pasted.
- **Desktop's sign-in.** Uses the account WorkBuddy desktop is signed in
  to. Nothing is copied: the app's file is read on each request, and never
  changed:
  - macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop[-ai].info`
  - Windows: `~/AppData/Local/CodeBuddyExtension/…`
  - Linux: `~/.local/share/CodeBuddyExtension/…`

  Since WorkBuddy 5.6 the app may keep that sign-in sealed at rest:
  `auth.accessToken` and `auth.refreshToken` arrive as
  `{"$wbEncrypted": 1, "envelope": "…"}` wrappers, each sealed with
  AES-256-GCM under a per-install key. The plugin opens them by running the
  app's *own* binary once as Node (`ELECTRON_RUN_AS_NODE=1`, never its GUI)
  to read that key from the app's private binding, and opens the envelopes
  in memory. Nothing is copied, decrypted to disk, or written back: the key
  and the tokens stay in memory, and the app's file is only ever read. A
  plain sign-in (credential protection off, the app's default) is read as it
  always was, and a sign-in that is sealed and cannot be opened reports
  itself as signed out rather than being taken as a plain one.

  The app's binary is found at `WORKBUDDY_ELECTRON_BIN` when that is set,
  else from the installer's own record, the standard `Program Files` roots,
  and those same two directories on any other drive — so an install on `D:`
  is found as well.

A browser sign-in is kept as an OpenCode `oauth` auth: the access and
refresh tokens, their expiry, the user id and the domain; desktop's as a
marker, `{"type": "oauth", "source": "desktop", "accountId", "uid"}`. OpenCode keeps it in
`auth.json`; magpie keeps it in `plugin-auth.json`. The access token is
refreshed a minute before it ends, and the new one is saved. If the refresh
fails, the old token is used while it lasts.

In magpie (0.1.684 or later) the plugin also gives `auth.refresh` with
`refreshLead` of 5 minutes: magpie renews a browser sign-in (an hour's
token) 5 minutes before it ends, once for the account, before its
requests, models and usage ask, and saves what it gives. It goes through
the same one-refresh-at-a-time as a request's refresh, so a refresh token
is never spent twice. A failed renewal, a refresh token past its end
included, doesn't mark the account, as the built-in never did; magpie
tries again later, and the old token is used meanwhile.
OpenCode doesn't call `auth.refresh`; the check before each request stays.

Desktop's sign-in is refreshed only when the app hasn't refreshed it
itself, and the new token is kept in memory, never written back, as magpie's
built-in WorkBuddy does.

## Requests

Chats are chat completions (`@ai-sdk/openai-compatible`) at `<API>/chat/completions`.
They are streamed only; WorkBuddy refuses a chat that isn't.

Each chat carries WorkBuddy's headers:
- `Authorization`, `X-User-Id`, `X-Domain`, `X-Product: SaaS`, `X-IDE-Type: WorkBuddy`;
- `User-Agent: WorkBuddy/5.5.6`. Without it, WorkBuddy answers error 10085;
- WorkBuddy AI also takes its client and conversation headers.

A chat that doesn't open with a system message is given WorkBuddy's
default one, as the app does.

## Models

When you are signed in, the models are the ones WorkBuddy's product config
gives its CLI agent (`GET /v3/config`), with their context, image input and
reasoning levels. Until then, or if WorkBuddy doesn't answer, the list below
is used.

`workbuddy`:
- Auto
- Hy4 preview, Hy3, Hy3-X
- Deepseek-V4.1-Flash, Deepseek-V4-Pro
- GLM-5.3, GLM-5.3-Flash, GLM-5.2, GLM-5.1, GLM-5v-Turbo
- MiniMax-M3
- Kimi-K3, Kimi-K2.7-Code, Kimi-K2.6

`workbuddy-ai`:
- Default, Fast, Balanced, Primary, Deep
- GPT-5.5, GPT-5.4, GPT-5.3-Codex
- Gemini-3.1-Pro, Gemini-3.5-Flash
- GLM-5.3, GLM-5.2
- Hy3
- Kimi-K3, Kimi-K2.6
- MiniMax-M3

A model's reasoning levels are its variants (`reasoningEffort`).

## Not here

magpie's built-in WorkBuddy does more than this package:
- the daily check-in;
- the credits meter (`/billing/meter/get-user-resource-summary`);
- several accounts under one provider.

OpenCode's plugin API has no place for these.
