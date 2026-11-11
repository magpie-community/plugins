# Tabbit for magpie

[Tabbit](https://web.tabbit.com) as a provider in [magpie](https://usemagpie.ai)
(and OpenCode). It signs in with the Tabbit Browser account already on this
computer, lists the account's real model catalog, and answers turns through
Tabbit's own chat API — so an agent behind magpie can pick `tabbit/Default`,
`tabbit/DeepSeek-V4.1-Flash`, `tabbit/GLM-5.3-Flash` and the rest like any
other provider, with the account's allowance, fallbacks and usage card.

## Install

```sh
magpie plugin add @magpie-community/opencode-tabbit-auth   # from the community list
# from this source tree instead:   magpie plugin add .
magpie plugin login tabbit                                 # pick “Read Tabbit Browser sign-in (macOS)”
magpie provider test tabbit                                # ✓ chat · Default
```

Then pick `tabbit/<model>` in any agent's model row on magpie's Agents page —
or route to it from a group:

```sh
magpie group add tabbit-pool models=tabbit/Default,tabbit/DeepSeek-V4.1-Flash routing=cheap
```

**每日自动签到**：装好并登录后，magpie → 设置 →「窗口重置时预热 / 每日自动签到」→
标签条最右的 **插件** → 「Tabbit · 每日自动签到」打开开关（还有「立即签到」按钮）。
Tabbit 的签到就是桌面宠物那个活动，结果会画在用量卡片上。

**OpenCode**：`opencode.json` 里加 `{ "plugin": ["@magpie-community/opencode-tabbit-auth"] }`，
再 `opencode auth login`。

**Provider id:** `tabbit`

This is not Tabbit's official API. It uses the endpoints Tabbit's own web app
calls, with the sign-in that app keeps, for one person on their own machine.

## Sign-in

Tabbit's sign-in is a `token` cookie: an RS256 JWT issued by
`web.tab-browser.com` with a **7-day** life. Two ways in:

| Method | What it does |
|---|---|
| **Read Tabbit Browser sign-in** (macOS) | Finds the cookie store Tabbit Browser keeps (`~/Library/Application Support/Tabbit Browser/Default/Cookies`), reads the `token` cookie, and decrypts it with the password in the login keychain under `Tabbit Browser Safe Storage`. Nothing is copied by hand; the browser does not have to be closed — the database is copied before it is read. |
| **Paste Tabbit token** | For anything the first method can't reach (Windows or Linux, a browser profile kept somewhere else). In Tabbit Browser, open `web.tabbit.com` and read the `token` cookie from the developer tools; paste it whole. |

A pasted value may be the bare JWT or a whole `name=value; name=value` cookie
string. The account id is read out of the token itself, so nothing else has to
be pasted.

There is no refresh endpoint. When the token runs out (7 days), magpie shows
the account as needing a sign-in again and the first method takes one more
click.

> **macOS only.** Reading the desktop's cookie is implemented for macOS. On
> Windows the store is DPAPI-encrypted and on Linux it uses a different store
> key; neither is done here. On those platforms the method refuses and names
> the platform, and the paste method is the one to use.

## Models

The catalog comes from the account:
`GET /proxy/v1/model_config/models?a=0&scene=chat` — the same call the Tabbit
app makes. A model's **id is the catalog's `display_name`, verbatim**
(`DeepSeek-V4.1-Flash`, `GLM-5.3-Flash`…), because that is the name a turn has
to be asked with.

| Catalog field | Becomes |
|---|---|
| `display_name` | the model id and name |
| `supports_images` | image input on the row |
| `support_thinking` | the reasoning flag (thinking arrives as `reasoning_content`) |
| `model_access_type` | `free_unlimited` / `free_metered` / `premium_only` |
| `hidden` | left out, as the app leaves it out |

**Client tools are off** (`toolcall: false`). The catalog's `supports_tools`
means Tabbit's *own* server-side tools — browser and search — not tools an
agent declares: a turn asked to call a client-declared tool answers that it has
no such tool. A tool-using agent should go through magpie's gateway tools
instead.

**Limits are not published** by Tabbit. Known ones are hard-coded
(`DeepSeek-V4.1-Flash` and `DeepSeek-V4-Pro`: 1M context); everything else
takes a default (`TABBIT_CONTEXT`, `TABBIT_OUTPUT`, 128k / 32k). A prompt past
a real limit comes back as Tabbit's own error.

**Premium models** answer `403` with code `492` on a free account. The
**Free models only** switch in the provider's options leaves them out of the
list instead of letting them fail at the turn.

## Daily check-in (签到)

Tabbit's check-in is the desktop pet's activity, and it runs on
`/api/commerce/activity/v1/sign-in` — the same two calls the browser makes:

```
GET  /api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet
POST /api/commerce/activity/v1/sign-in   {request_no, scene_codes:["desktop_pet"]}
```

The plugin implements magpie's `auth.checkin` hook, so it appears where
WorkBuddy's does: **Settings → Usage → Plugins → Tabbit**, on by default after
you flip it, and magpie then runs it once a day per account and draws the
outcome on the account's card.

It reads the status first — free, and it says whether the activity is open —
and only claims when the day is actually unsigned. What Tabbit's answers
become:

| Tabbit says | The card shows |
|---|---|
| `signed_today: true` | **done** (no claim is sent at all) |
| `sign_in_result: "signed"` | **claimed**, with the usage it granted and the day count |
| `sign_in_result: "already_signed"` | **done** (a race, not a failure) |
| `activity_open: false` | **inactive** |
| no result for the scene | **ineligible** |
| any other word | **failed**, carrying Tabbit's own word for it |

`desktop_pet` is the only scene the service accepts — every other name comes
back `SIGN_IN_SCENE_UNSUPPORTED`. The pet itself needs `required_days` (3)
before it can be adopted, so a signed day also reports the streak
(`1/3 days`).

A `sign_in_result` this plugin hasn't seen is reported as a failure rather
than guessed as a claim: a wrong "claimed" is worse than a failure you can
read.

## Usage

`GET /api/commerce/quota/v1/usage` gives the cycle's allowance, which the
Usage card shows as **Cycle usage** — a percentage, with when the cycle resets
(Tabbit's cycles are weekly, named in Beijing time).

## How a turn is sent

`loader()` hands magpie a `fetch` that rewrites `chat/completions` into the
three calls Tabbit's app makes:

```
POST /api/v3/chat/rooms                      → a room (the conversation)
POST /api/v3/chat/rooms/<room>/runs          → the turn: { content, selected_model }
POST /api/v3/chat/rooms/<room>/join          → text/event-stream
```

The stream is written back as OpenAI chunks: `assistant_message_delta` →
`choices[].delta.content`, `event_message_chunk(thinking)` →
`reasoning_content`, `run_completed` → `finish_reason: "stop"`. A turn that
ends without `run_completed` or `run_failed` — the stream cut, the turn timing
out — comes back as an error event, not as a short answer: an agent would
otherwise take a half or empty reply as the answer. A turn that times out also
sends `chat/stop`, so it stops spending the account's allowance.

**Conversation history** lives in the room. Each magpie session is given one
room (`chat.headers` carries the session id), so a follow-up inside a session
sends only the new message and hangs it off the previous answer's id — the room
is not replayed into the prompt. A request whose transcript doesn't continue
the room (a new session, an edited history, a room Tabbit reset) gets a fresh
room with the whole transcript flattened into one prompt; measured, the model
answers the last question with the earlier turns as context.

`maxConcurrency` is **1**: Tabbit answers one turn at a time.

## Working on this package

From a checkout of this source tree, or from the published package:

```sh
magpie plugin add .        # this checkout; the community list has the package
magpie plugin login tabbit # or: pick the provider in the app
magpie provider test tabbit
magpie models tabbit
```

In OpenCode, add `@magpie-community/opencode-tabbit-auth` under `plugin` and
sign in with `opencode auth login`.

## Development

```sh
node --test tests/*.test.mjs   # Bun: `bun test`. Every hook, a synthetic
                               # cookie store, a replayed SSE turn
node scripts/check.mjs         # loads the hooks the way magpie and OpenCode do
```

The tests never touch the network. `tests/plugin.test.mjs` stubs Tabbit's four
endpoints; `tests/sse.test.mjs` replays a recorded turn, including a rejoin's
snapshot and a turn cut short; `tests/cookie.test.mjs` seals and unseals a
synthetic Chromium `v10` blob.

## Limits worth knowing

- A turn is a web-app turn: first text takes seconds, and one turn runs at a
  time.
- Tabbit keeps the room's own history, so a flattened prompt is the fallback
  path, not the normal one. Very long transcripts past the model's limit are
  Tabbit's call, and it answers with its own error.
- The catalog call answers without a valid token; a token that has really
  expired shows up at the first turn (`401 请先登录`), which marks the account.