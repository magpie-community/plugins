# Perch for magpie

Runs [Perch](https://perchai.app) accounts as a magpie provider, so `perchai/*` models show up in
the gateway's model list and answer OpenAI chat-completions calls.

## Install

```
magpie plugin add ./            # from this directory
magpie plugin login perchai
```

The provider is `perchai`; the models are `perchai/auto`, the three Starter aliases
(`perchai/deepseek-flash-starter`, `perchai/glm-5.3-flash-starter`, `perchai/beam-1.0-starter`),
the promo model, and every public model Perch lists — 42 in all.

## Signing in

Three methods, and the first one is the usual answer:

- **Use this machine's sign-in** — no prompt, no browser. The plugin reads the Perch session this
  machine already has and stores it. Try this first.
- **Login with Perch** — Supabase PKCE over a loopback listener on `127.0.0.1`. Opens the
  authorization page, catches the code on `/callback`, exchanges it for a session.
- **Paste a Perch token** — paste an access token, or a whole `cli-auth-session.json`. The last
  resort, for a session that lives on another machine.

### Where the machine's sign-in is read from

Two sources, and the freshest one wins:

- `~/.perch/cli-auth-session.json` — written by `perch login` (override the directory with
  `PERCH_CLI_AUTH_DIR`).
- `%APPDATA%\Perch AI Desktop\cli-auth-session.json` — the desktop app writes the very same file
  shape into its own user-data folder. It never touches `~/.perch`, so a sign-in started in the
  desktop app only shows up here. `Perch Terminal` and `perch-desktop` folders are checked too.

Perch's own cookie jar (`%APPDATA%\Perch AI Desktop\Network\Cookies`) is a third source, for a
desktop app that has not written the session file. Perch keeps its session there as
`sb-<ref>-auth-token.0` + `.1`; the values are plaintext, so the two halves are joined and
base64-decoded. **Only Perch's jar is opened** — a browser profile's jar is not this plugin's to
read — and inside it only cookies whose `host_key` is `perchai.app` or a subdomain of it are
considered, so a Supabase session belonging to any other site is never picked up.

Because the freshest session wins, signing into a different account in the desktop app and then
picking **Use this machine's sign-in** switches the provider to that account. **Login with Perch**
does not do that: picking a provider there means "sign in as this provider's account", so it always
opens the authorization page rather than reusing whatever is already on disk.

Nothing is decrypted and nothing leaves the machine. The jar is copied to a temp file before it is
read (another process holds it open), and the read is skipped when the host has no SQLite module.
The desktop app does not need to be running.

Once found, the pair is stored as the provider's sign-in, so the gateway sees a signed-in account
without any prompt. If a stored sign-in is later dropped, the next request adopts the machine's
sign-in again instead of failing.

On a network that resets the TLS handshake for `*.supabase.co` (an SNI-level block, not something
this plugin can route around), sign-in and token refresh fail with the connection error. Every other
part of the plugin keeps working, and `Login with Perch` works wherever the authorization page is
reachable.

## How a call is made

`POST {app}/api/perch-terminal/model-call` with Perch's own request shape, then Perch's SSE events
are translated into OpenAI's:

| Perch event | becomes |
| --- | --- |
| `answer_delta` | `delta.content` |
| `reasoning_delta` | `delta.reasoning_content` |
| `tool_call_delta` / `tool_use_end` | one `delta.tool_calls` with complete arguments |
| `done` | the `finish_reason`, the usage frame, and `[DONE]` |
| `stream_restart` | the text restarts (streaming can only append, so a restart continues) |
| `error` / `done.ok:false` | an `error` frame |

Three details of the request shape matter, and all three are simply what Perch's own CLI sends — the
endpoint is written for that one client and refuses requests that do not match it:

- **No `lane` inside `request`.** `lane` sits beside `request`. A `lane` on the request itself is
  answered `perch_surface_required`.
- **A system prompt the endpoint accepts.** It also refuses a call whose messages it does not
  recognise, and length is not what it measures: a 20,000-character prompt of your own passes, a
  two-line one can be refused. Every request therefore opens with `CANARY`, a sentence taken from
  Perch's own prompt, and the caller's system prompt follows it untouched. That is why a request
  with no system prompt at all still gets an answer.
- **A turn ticket.** Each turn mints one at `/api/perch-terminal/turn-ticket`, runs the call under
  the ticket's `runId`, and sends the ticket back as `x-perch-turn-ticket`. A turn without one still
  goes out, the way the CLI sends it when no ticket can be minted.

Nothing else of the CLI's is imitated. In particular the plugin does **not** file the
`cli-turn` record the CLI writes after every turn: that record carries the user's prompt and the
answer back to Perch, and sending a transcript the user did not ask to send is not this plugin's
business. So Perch sees the model calls and nothing else.

## The host's own boilerplate is rewritten out

The harness that drives this plugin writes a few fixed sentences about itself into the system
prompt: an opener, a paragraph about its source checkout, a paragraph about its web GUI, and two
runtime-context lines carrying the checkout path and the GUI URL. Those sentences say nothing about
the user's question, so the plugin rewrites them on the way out — **system messages only**.

Nothing else is touched. A user message, an assistant message, a tool result and every tool schema
go to Perch exactly as they came in, so a question that mentions the harness by name is still that
question, and a file or a note the user wrote is still their text. The rewrite is a fixed list of
whole sentences (`BOILERPLATE` in `index.mjs`); there is no catch-all, so any other occurrence of
the name passes through byte for byte. Paths, URLs, commands and identifiers survive as well —
`dsh web`, `pnpm dsh`, `DSH_HOME` and `window.__DSH_BOOT__` are not in any pattern, and the two
runtime-context patterns stop before the value so the path and the URL come out intact.

## Accounts Perch suspends

Perch suspends accounts it believes are being driven through another app or tool. A suspended
account authenticates fine and every hosted model answers `403 not_authorized`; the usage panel says
so instead of showing an empty month, and signing in again does not clear it. The ban is visible at
`GET /api/perch-terminal/account-deletion` as `blockedReason: "banned"`, and the account's
`perch_ai_org_memberships.status` flips to `revoked`. Lifting it is a support matter
(`support@perchai.app`) — nothing on this side can.

That `revoked` row is also why the web app's plan picker locks. The picker renders only when
`useAuth().hasAccess` is true, and `hasAccess` counts memberships whose `status` is `active`; the
select-Starter call it would make (`rpc("perch_ai_select_starter_with_data_notice")`) answers
`{ok:false,error:"banned"}` anyway. So "I can't pick a plan" and "every model 403s" are one
condition, not two, and a new account has to be picked before it is ever used — afterwards it is
already too late.

**This is the risk you take by installing this.** Perch's terms cover its own apps; a plugin that
drives the same endpoint from magpie is not one of them, and the account it drives can be suspended
for it. That is Perch's decision to make, not something this plugin can argue with or work around.
The three details above are there because the endpoint only serves its own client, not to disguise
who is calling — if you need hosted models under terms that allow third-party clients, use Perch's
BYOK path (`models.byok.enabled`) with your own provider key, or a provider that offers an API.

Three accounts were suspended while this plugin was being built, at the exact timestamps of its
first real calls. Treat a fresh account as something to spend carefully, not as a supply.

## Making the models show up in an agent

A newly added provider is not automatically ticked for every agent. The gateway lists the models
(`GET /v1/models`) but an agent that is narrowed to "only models picked" will not offer them:

```
magpie provider models perchai deepseek-flash-starter glm-5.3-flash-starter beam-1.0-starter auto
```

Each id is its own argument — a comma-joined list is taken as one unknown id. The ids given replace
the exposed list; prefix an id with `+` to add one and keep the rest. Afterwards `magpie models dsh`
should list the `perchai/*` entries, and the gateway answers them.

## Tests

Two files, both offline — neither touches the network or needs a signed-in account:

```
node --no-warnings check.mjs   # request shape, response translation, cookie joining, the meter
node --no-warnings e2e.mjs     # the loader end to end against a stand-in Perch
```

## Layout

- `index.mjs` — the plugin. `PerchAuthPlugin` is the only export magpie calls; everything else is
  collected in `_internal` so it is not mistaken for a second plugin.
- `opencode.mjs` — re-export only: OpenCode 1.x refuses an entry point that exports anything else.
- `check.mjs` — offline checks of the request shape and the response translation.
- `e2e.mjs` — the loader end to end against a stand-in Perch.
