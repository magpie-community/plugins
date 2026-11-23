# magpie-logicc-provider

> [Logicc](https://app.logicc.com) as a provider for [magpie](https://usemagpie.ai) and OpenCode — using the account you already pay for in the browser.

English · [简体中文](README.zh-CN.md)

> [!IMPORTANT]
> **Not a coding-agent provider.** Logicc's chat endpoint takes about 120,000 characters per request, and Claude Code's system prompt alone is roughly that. It works for questions, writing and lightweight agents; it does not work for Claude Code, Codex, or any agent with a large fixed prompt. See [Limitations](#the-context-window-is-small--this-is-not-a-coding-agent-provider) for the measurements.

---

Logicc has an official OpenAI-compatible API, but a key for it is provisioned by hand: you email their team with a company name, a use case, and the models you need. There is no self-service page. This plugin reaches the same models through the app you already have a subscription for, by speaking to it the way the app's own frontend does.

No sidecar process. No localhost port to babysit. The translation from OpenAI's request shape to Logicc's lives in the `fetch` that `auth.loader` returns — the same mechanism the WorkBuddy and Tabbit plugins use for their own protocols.

- **Zero dependencies** — Node built-ins only
- **Live model catalog** — whatever your account may actually use, not a hardcoded list
- **Client tool calls** — through a JSON envelope, since Logicc's chat endpoint takes no tool schema
- **Self-renewing sign-in** — session JWTs last 60 seconds; the plugin renews on demand and stores rotated cookies back

## Contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [Signing in](#signing-in)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Behaviour you should know about](#behaviour-you-should-know-about)
- [Limitations](#limitations)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [License](#license)

## Why this exists

Logicc publishes an OpenAI-compatible gateway at `https://api.logicc.cloud/v1`, documented at [help.logicc.com](https://help.logicc.com/docs/api/logicc-api-dokumentation). Access works like this:

> Request an API key from their team with the subject `API`. Include your company, intended use case, required models, expected request volume, and target environment.

That is fine for a company with a procurement process, and useless for anyone who simply has the €20/month subscription and wants it in their agent. So this plugin takes the other route — the one the web app already uses:

```
sign in   →  Clerk `__client` cookie
catalog   →  GET  app.logicc.com/api/models
a turn    →  POST app.logicc.com/api/chats  →  POST /api/chats/<id>   (SSE, AI SDK v6)
```

If you *can* get an official key, do that instead — it is cleaner, and it needs no plugin at all: add `https://api.logicc.cloud/v1` as an OpenAI-compatible provider in magpie's Settings, paste the key, and fetch the model list from the same base URL plus `/models`.

## Install

Requires **Node.js 22+** and magpie.

From GitHub — no npm account or registry needed:

```bash
magpie plugin add github:romsang/magpie-logicc-provider
```

From a local clone:

```bash
git clone https://github.com/romsang/magpie-logicc-provider.git
magpie plugin add "$(pwd)/magpie-logicc-provider"
```

**Use an absolute path.** A relative `.` resolves against magpie's working directory, not yours, and fails with `its package names no file to load`.

**Restart magpie afterwards.** It builds its subscription table at launch, so a new plugin's sign-in methods are not picked up until then.

Verify:

```bash
magpie plugin list          # → logicc (Logicc, N models)
magpie provider test logicc # → ✓ chat  4000 ms · <model>
```

## Signing in

Which methods you see depends on whether the plugin process may read Chrome's cookie store. On most setups it may not — see [Limitations](#limitations) — so expect one method.

### Paste the `__client` cookie (works everywhere)

This is the path that actually works, and the one most people will use. It takes about two minutes.

#### 1. Open Logicc in Chrome

Go to `https://app.logicc.com` and confirm you are **signed in** — your account name should be visible in the sidebar.

> Use the **same browser you signed in to Logicc with**. A different browser, or a private window, will not have the cookie.

#### 2. Open DevTools

On **that page**, use any of:

| Way | What to press |
|---|---|
| Keyboard (fastest) | **`⌥⌘I`** — Option + Command + I |
| Right-click | Anywhere on the page → **Inspect** |
| Menu bar | **View** → **Developer** → **Developer Tools** |
| Console only | **`⌥⌘J`** |

DevTools takes up half the window. Drag it out into its own window if the panels are cramped.

#### 3. Switch to the Application panel

In the tab strip at the top of DevTools, find **Application**.

> If the window is narrow, tabs collapse into a **`»`** overflow. Look there.
> If you don't even see `»`, widen the DevTools window first.

#### 4. Find Cookies

Scroll the left-hand sidebar to the **Storage** group and expand **Cookies**.

Several domains are listed. Click **`https://clerk.logicc.com`**.

> ⚠️ This is the step people get wrong: it must be **`clerk.logicc.com`**, not `app.logicc.com`.
> Both domains have cookies, but `__client` lives only under clerk.

#### 5. Copy the `__client` value

A table appears on the right. Find **`__client`** in the **Name** column, then double-click the **Value** cell on that row, select all, and copy.

The value is long — **over 500 characters** — and looks like gibberish, usually starting with `eyJ...`. That is normal.

> ⚠️ Don't grab the wrong row. These are easy to confuse:
>
> | Name | Wanted? |
> |---|---|
> | **`__client`** | ✅ **this one** |
> | `__session` | ❌ no, a different credential |
> | `__client_uat` / `__client_uat_xxx` | ❌ no, a timestamp |
> | `clerk_active_context` | ❌ no |
>
> Only `__client` — no suffix, no `uat`.

#### 6. Paste it into magpie

Back in magpie, paste it into Logicc's sign-in field and save.

**No session id is needed.** The plugin looks it up from the cookie via Clerk's `/v1/client`.

After saving, the account should show as signed in and list its models (around 11). If it signs in but shows no models, refresh once.

---

#### Why this has to be copied by hand

`__client` is **`httpOnly`** — a browser security rule meaning **no page script can read it**. Not from the Console (`document.cookie` won't show it), and not by a plugin trying to read it from the page.

So it can only come from DevTools' cookie table. That is also why one-click browser sign-in is unavailable in some environments — see [Limitations](#limitations).

#### If it still doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| Copied value is short, doesn't start with `eyJ` | Wrong row, or you copied `__client_uat` | Back to step 5; check the Name is exactly `__client` |
| Rejected as invalid | A character was lost off either end | Select all and copy again, mind the first and last characters |
| Rejected as expired | You signed out of Logicc in the browser | Sign in again, then copy a fresh value |
| Saves, but no models appear | The account has no model access | Check the Logicc web app lists models for you |

---

#### Is this value safe to handle

- It is equivalent to your Logicc web session. **Never post it publicly** — issues, screenshots, chat groups.
- It is stored locally in `~/.config/magpie/plugin-auth.json` with mode `600` (only your user can read it).
- Signing out of Logicc in the browser invalidates it; copy a new one afterwards.

> When reporting a bug, **do not paste this value.** Saying "ends in `…Zeg`" is enough — the last three characters identify the account.

### Browser sign-in (when the cookie store is readable)

Click **Sign in**, and Logicc's page opens in your browser. Sign in there; magpie picks the account up on its own.

This needs read access to the browser's cookie store, which macOS grants per application. It works from a terminal, and generally does not work when magpie runs as a `launchd` background service. Where it is not available the plugin does not offer the method at all, rather than show an entry that would fail after you had done your part.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `LOGICC_CONTEXT` | `200000` | Fallback context size for a model whose `contextWindow` band is unknown |
| `LOGICC_OUTPUT` | `32000` | Max output tokens reported for a model |
| `MAGPIE_LOGIC_SIGNIN_DEBUG` | *(unset)* | Path to append sign-in diagnostics to |

Provider options exposed in magpie's UI:

- **Client tools through a JSON envelope** — on by default. Off makes a request that declares tools fail instead of being rewritten.

## How it works

### Auth

`__client` is the only durable credential. It exchanges for a session JWT at `clerk.logicc.com/v1/client/sessions/<sid>/tokens`, and that JWT lasts **about 60 seconds** — so it is cached and renewed on demand, not per request. Clerk rotates `__client` on some refreshes; the rotated value is written back, or the next renewal fails.

`auth.refresh` renews ahead of expiry so an idle account stays usable without a re-paste.

### A turn

Logicc's chat endpoint takes one `prompt` string, not a message array, so a turn is written out as text:

```
[system]
You are a helpful assistant.

[user]
Summarise this file.

[assistant]

[Tool calls]
[{"id":"c1","function":{"name":"read"}}]

[Tool result: c1]
the file contents
```

**A chat does not carry its own history.** Measured against a live account: two turns posted to the same chat id treat each other as strangers — the second does not see the first. So every turn sends the whole transcript and creates a fresh chat. That also keeps a second copy of the conversation from living upstream, where Logicc would store and title it.

### Tool calls

Logicc's models have no client-tool channel, so a request that declares tools is rewritten into an instruction to answer with one JSON envelope:

```json
{"content": "text for the user or null", "tool_calls": [{"name": "…", "arguments": {}}]}
```

The reply is parsed back into OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Verified working: `calculate({"expression":"6 * 7"})`.

### Streaming

Logicc answers with AI SDK v6 events (`text-delta`, `tool-input-start`, `tool-input-delta`, `finish`, …). `src/sse.mjs` folds them into text, reasoning, tool calls, and usage, and the plugin re-emits them as `chat.completion.chunk` lines.

## Behaviour you should know about

Measured against a live account, not inferred from documentation. Each one shaped the code:

| Finding | Consequence |
|---|---|
| `__client` is `httpOnly` | No page script can read it. The session id is looked up from the cookie instead of asked for |
| Session JWT lives ~60 s | Renewed on demand; rotated cookies are persisted |
| **A chat does not remember its own turns** | Full transcript sent every turn, no chat reuse |
| `finish` carries no `finishReason` and no token counts; `/api/usage`, `/api/me`, `/api/credits` are 404 | Usage is reported as `null`, never invented |
| No reasoning deltas, even for a model declared `always-reasoning-configurable` | `reasoning: false`, so agents don't wait for tokens that never arrive |
| `contextWindow` is a band (`gigantic`, `medium`), not a number — and it describes the **vendor's** window, not this endpoint's | Every band reports the endpoint's real ceiling (~28,000 tokens). Reporting "gigantic" as 1,000,000 made agents fill the context and get a bare HTTP 400; verified by bisection: ~115,600 chars passed, ~125,000 returned 400 |
| A prompt that looks like host filesystem access returns an **empty stream** — not even a `start` event | Reported as an error, never as "the model had nothing to say" |

## Limitations

### The context window is small — this is not a coding-agent provider

**Logicc's chat endpoint accepts about 120,000 characters per request, and rejects anything larger with a bare HTTP 400.** It is not the model's own window: Logicc labels these models `contextWindow: "gigantic"`, which sounds like a million tokens, but the endpoint in front of them takes roughly 30,000 tokens of prompt and no more. Measured by bisection against a live account: 120,000 characters passed, 122,000 returned 400.

That number matters because of what an agent sends before it does anything useful:

| What | Size |
|---|---|
| Logicc's endpoint limit | ~120,000 characters |
| Claude Code's system prompt, with tool definitions | ~110,000–128,000 characters |

A Claude Code turn is over the limit **before the first exchange**. Codex is similar. Which means:

| Use | Works? |
|---|---|
| Asking a question, writing, translating, short analysis | ✅ |
| OpenCode and other lightweight agents | ✅ usually |
| **Claude Code / Codex / long-context coding agents** | ❌ the system prompt alone fills it |
| Analysing a very long document | ⚠️ only while it stays under ~120,000 characters |

The plugin does **not** truncate to fit. Cutting a system prompt or a transcript silently changes what the agent was told, and the answer that comes back looks normal while being built on a request nobody approved. A turn that is too long is refused with a clear message instead.

If you want Claude Code or Codex to run on these models, get an official Logicc API key — the gateway at `api.logicc.cloud` is a different front end and may allow more — or use a provider whose window actually fits.

### Browser sign-in is not portable

Reading Chrome's cookie store means decrypting it with the key macOS keeps in the login keychain, and macOS gates a browser's cookie store *per application*. Measured on macOS 26:

| Who is reading | Direct file read | Via `osascript do shell script` |
|---|---|---|
| Terminal / script | ✅ | ✅ |
| magpie's plugin host under `launchd` | ❌ `EPERM` | ❌ silently refused (`authorization denied` from TCC) |

A `launchd`-started background service has no GUI session to grant Automation permission to, so the refusal is silent — no dialog, no prompt. Nothing in a plugin can or should circumvent that. This is why the paste method exists and why the browser method is hidden where it cannot finish.

**Other limits:**

- Sign-in is a browser session, not an API contract. If Logicc changes its frontend or revokes the session, re-paste.
- No token or cost reporting — see the table above.
- Text only. Images are named in the prompt (`[image]`), not sent.
- `maxConcurrency: 1` — Logicc serialises per account.

## Development

```bash
npm test                          # 36 unit tests, no network
node test/live.e2e.mjs <file>     # end to end against a real account; spends quota
```

`live.e2e.mjs` takes a file holding the `__client` value and covers: config injection, the live catalog, a streamed turn, history carried by the prompt, a tool call, and a guarded prompt surfacing as an error.

Layout:

```
index.mjs           the plugin: config, auth methods, provider.models, loader
opencode.mjs        the export surface magpie and OpenCode 1.x load
src/logicc.mjs      talking to Logicc: cookies, JWT renewal, chats, models
src/signin.mjs      browser sign-in: oauth contract, Chrome cookies, TCC probe
src/sse.mjs         AI SDK v6 event stream → text, reasoning, tool calls
src/models.mjs      catalog entries → magpie model rows
```

## Disclaimer

Not affiliated with Logicc GmbH. This is an unofficial client that uses a subscription you already have, through the same interface the web app uses. Logicc's terms of service may not welcome that, and an account can be rate-limited or suspended for unusual traffic. Use it on an account you can afford to lose.

For anything long-lived, get an official key — see the contact route in [Logicc's API documentation](https://help.logicc.com/docs/api/logicc-api-dokumentation).

Provided as-is under the MIT licence, with no warranty of any kind.

## License

[MIT](LICENSE)
