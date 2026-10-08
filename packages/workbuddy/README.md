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

  A sign-in the app keeps encrypted can't be read, and this way fails.

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
- the client's, which WorkBuddy's usage list shows as the client that asked
  (使用端): `X-Agent-Purpose: conversation`, `X-IDE-Name: WorkBuddy`,
  `X-IDE-Version`, `X-Agent-Intent: craft`, `X-Requested-With`. Both builds
  send them, as WorkBuddy's own client does; a chat without them is counted
  under no client at all;
- the conversation's ids: `X-Conversation-ID`, `X-Conversation-Request-ID`,
  `X-Conversation-Message-ID`, `X-Request-ID`. WorkBuddy's backend counts a
  user send as one request by `X-Conversation-Request-ID`, so every step of
  one send — a tool result sent back, a retry, another account answering —
  carries the same one, and the user's next message carries another. The
  conversation's is the session magpie (or OpenCode) names the request by,
  else the chat's first user message; nothing is made up when neither names
  one, a made-up conversation of the request's own being what splits one
  conversation into many in the usage detail;
- WorkBuddy AI also takes `X-Agent-Type: main`.

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
