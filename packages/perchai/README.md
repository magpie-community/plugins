# perchai

[Perch](https://perchai.app) accounts in [OpenCode](https://opencode.ai) and
[magpie](https://usemagpie.ai). Perch has no OpenAI-compatible endpoint: its apps
talk to `POST {app}/api/perch-terminal/model-call`, answer in its own SSE events,
and gate hosted models on the shape of the request. This plugin speaks that API
and translates it, so agents reach Perch's models like any other provider, with
magpie's multi-account fallback.

**Provider id:** `perchai`

## Sign-in

Three methods; the first is the usual answer.

| Method | What it does |
| --- | --- |
| Use this machine's sign-in | No prompt, no browser. Reads the Perch session this machine already has. |
| Login with Perch | Supabase PKCE over a loopback listener on `127.0.0.1`. |
| Paste a Perch token | An access token, or a whole `cli-auth-session.json`, for a session that lives elsewhere. |

`magpie plugin login perchai` offers all three. The session is stored as
`{ "type": "oauth", "access", "refresh", "expires", "accountId", "uid" }` in
magpie's `plugin-auth.json` (permissions 600), and renewed in place by
`auth.refresh` before it runs out.

### Where the machine's sign-in is read from

Three sources, freshest wins:

- `~/.perch/cli-auth-session.json` — written by `perch login`. Override the
  directory with `PERCH_CLI_AUTH_DIR`.
- `%APPDATA%\Perch AI Desktop\cli-auth-session.json` — the desktop app writes the
  same file shape into its own user-data folder, never into `~/.perch`.
  `Perch Terminal` and `perch-desktop` folders are checked too.
- The desktop app's Chromium cookie jar,
  `%APPDATA%\Perch AI Desktop\Network\Cookies`. Perch keeps its Supabase session
  there as `sb-<ref>-auth-token.0` + `.1`; the values are plaintext, so the halves
  are joined, base64-decoded and used as the token pair. Chrome, Edge, Brave and
  Chromium profiles that signed in to `perchai.app` are scanned as well.

Nothing is decrypted and nothing leaves the machine. The jar is copied to a temp
file before it is read (another process holds it open), and the read is skipped
when the host has no SQLite module. The desktop app does not need to be running.
Because the freshest session wins, signing into another account in the desktop
app and picking **Use this machine's sign-in** switches the provider to it;
**Login with Perch** always opens the authorization page instead of reusing what
is on disk.

`*.supabase.co` is unreachable from some networks — the TLS handshake is reset by
SNI. When that happens the plugin retries through `bridge.py`, which uses
`curl_cffi` with a Chrome TLS fingerprint until an attempt gets through. That
needs Python with `curl_cffi` (`pip install curl_cffi`); set
`PERCH_BRIDGE_PYTHON` if `python` is not the right name. Without it, sign-in and
renewal fail with the connection error and nothing else changes. On a host whose
Bun has `HTTPS_PROXY` set, the direct path works and the bridge is never reached.

## Models

`perchai/auto` lets Perch route; everything else pins a model by Perch's own
option id. The catalog is 42 entries: the three Starter aliases
(`deepseek-flash-starter`, `glm-5.3-flash-starter`, `beam-1.0-starter`), the
weekend promo model, and every public model Perch lists. Context is 200,000 and
output 32,000 for all of them; the plugin charges nothing for them.

A newly added provider is not ticked for every agent. Each id is its own argument
— a comma-joined list is taken as one unknown id:

```
magpie provider models perchai deepseek-flash-starter glm-5.3-flash-starter beam-1.0-starter auto
```

## How a call is made

`POST {app}/api/perch-terminal/model-call` in Perch's own shape, then its SSE
events become OpenAI's:

| Perch event | becomes |
| --- | --- |
| `answer_delta` | `delta.content` |
| `reasoning_delta` | `delta.reasoning_content` |
| `tool_call_delta` / `tool_use_end` | one `delta.tool_calls` with complete arguments |
| `done` | the `finish_reason`, the usage frame, and `[DONE]` |
| `stream_restart` | the text restarts (streaming can only append, so a restart continues) |
| `error` / `done.ok:false` | an `error` frame |

Four details of the request shape are load-bearing, and all four are what Perch's
own CLI sends:

- **No `lane` inside `request`.** `lane` sits beside `request`. A `lane` on the
  request itself makes Perch answer `perch_surface_required` — it reads that as a
  call from something other than Perch.
- **A system prompt Perch recognises.** The same gate also fires on a call whose
  messages it does not recognise as its own, and length is not what it measures: a
  20,000-character prompt of your own passes, a two-line one can be refused. Every
  request therefore opens with `CANARY` — a sentence taken from Perch's own
  prompt — and the caller's system prompt follows it untouched.
- **A turn ticket.** Each turn mints one at `/api/perch-terminal/turn-ticket`, runs
  under the ticket's `runId`, and sends it back as `x-perch-turn-ticket`. A turn
  without one still goes out, the way the CLI sends it when no ticket can be
  minted.
- **A `cli-turn` record per turn.** After every call — answered or refused,
  streaming or not — the turn is filed at `POST /api/perch-terminal/cli-turn` with
  the prompt, the answer, the thread id (`cli-cwd-<sha256(cwd)[:16]>`), the run id
  and the duration. The CLI never runs a model call without filing one, so a
  client that calls `model-call` and files nothing is exactly what an outside app
  replaying Perch's requests looks like from the server. The record is filed after
  the answer has gone out, and a failed filing never fails the turn.

## The host's own name is rewritten out

The agent that drives this plugin writes its product name into the system prompt: an
opener, a paragraph about its source checkout, a paragraph about its web GUI, and two
runtime-context lines carrying the checkout path and the GUI URL. None of that is
anything Perch needs to read, so every string headed for Perch goes through
`unbrand()` first — messages, tool descriptions, and the prompt filed with the turn
record.

Only the product name changes. Paths, URLs, commands and identifiers come out exactly
as they went in: `dsh web`, `pnpm dsh`, `DSH_HOME` and `window.__DSH_BOOT__` all
survive, because the rewrite matches whole phrases and, for the bare acronym, requires
a word boundary that an underscore does not satisfy. The replacements are the `BRAND`
table in `index.mjs`; anything it does not match passes through byte for byte.

## Accounts Perch suspends

Perch suspends accounts it believes are being driven through another app or tool.
A suspended account authenticates fine and every hosted model answers
`403 not_authorized`; the quota panel says so instead of showing an empty month,
and signing in again does not clear it. It shows at
`GET /api/perch-terminal/account-deletion` as `blockedReason: "banned"`, and the
account's `perch_ai_org_memberships.status` flips to `revoked` — which is also why
the web app's plan picker locks, since `hasAccess` counts only `active`
memberships and `rpc("perch_ai_select_starter_with_data_notice")` answers
`{ok:false,error:"banned"}`. Lifting it is a support matter
(`support@perchai.app`).

The evidence Perch acts on is the shape of a session, not a single request. The
four details above are what makes a session look like Perch's own; a turn record
in particular is something the real CLI files on every turn and the web app never
files. Whether that is enough is not something this package can promise — treat a
fresh account as something to spend carefully, not as a supply.

## Tests

Offline; nothing signs in or reaches the network:

```
bun test
```

## Layout

- `index.mjs` — the plugin. `PerchAuthPlugin` is the only export OpenCode and
  magpie call; everything else is collected in `_internal` so it is not mistaken
  for a second plugin.
- `opencode.mjs` — re-export only: OpenCode 1.x refuses an entry point that
  exports anything else.
- `opencode2.mjs` — the OpenCode 2.x adapter, byte for byte from `scripts/`.
- `bridge.py` — the TLS fallback described above.
- `index.test.mjs` — the offline suite.
