# @roadkid/opencode-loomy-auth

English | [中文](./docs/README.zh.md)

An [OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider
plugin for a Loomy (iFlytek) account. You sign in with Loomy's phone-code
sign-in, your chats go through Loomy's OpenAI-compatible model gateway, and
your points — the permanent balance and the daily grant, two wallets — and the
daily first-login refresh that renews the grant land on the Usage card.

| Provider id | Sign-in | Upstream hosts |
|---|---|---|
| `loomy` | phone code (+86) | `loomyad.xunfei.cn` (account plane `account.xfinfr.com`) |

The package exports `LoomyAuthPlugin` (`loomy`) for magpie and OpenCode
v1, and — from 0.2.0 — a default export (`{ id: "loomy-auth", setup,
server }`) for OpenCode ≥ 2.x, with the `server` function the same V1
factory for hosts that read object entrypoints (magpie's own loader
among them). One package, every host.

## Install

```sh
magpie plugin add github:road-kid/opencode-loomy-auth    # this repository
magpie plugin add @roadkid/opencode-loomy-auth  # the npm name
magpie plugin add .                                      # a local copy — no npm, no GitHub
magpie plugin login loomy      # the phone-code sign-in
magpie provider test loomy     # one small request per API, to check the wiring
magpie quota                   # the points card
```

The same package loads in OpenCode (the `"plugin"` array in `opencode.json`,
then `opencode auth login`) — for OpenCode ≥ 2.x, see
[OpenCode v2](#opencode-v2). magpie keeps the sign-in in `plugin-auth.json`
(mode 600); OpenCode keeps it in `auth.json`.

## OpenCode v2

From 0.2.0 the package loads in OpenCode ≥ 2.x as a default-export plugin
(`{ id: "loomy-auth", setup }`), beside the named export magpie and
OpenCode v1 read. Same code, same sign-in, same gateway.

### Install

Three ways, pick one:

- the `plugins` key of `opencode.json(c)` with the npm name:
  `"plugins": ["@roadkid/opencode-loomy-auth"]`;
- the same key with a local directory:
  `"plugins": ["E:/path/to/opencode-loomy-auth"]` — the path must be a
  directory, a file path is skipped;
- or the directory itself into `~/.config/opencode/plugins/` (global) or
  `.opencode/plugins/` (project) — OpenCode discovers it on its own and
  hot-reloads it when files change.

### Sign-in

`opencode auth login` (or `/connect` in the TUI) → pick the Loomy
integration → the phone-code way → the 11-digit phone number → the SMS
arrives (six digits, five minutes to live) → type the code → done. The
session lasts fourteen days and there is no refresh — when it ends, sign
in again. The desktop OpenCode's account-connection screen reads the same
server APIs.

### Models

Signed in, the `loomy` provider appears on its own; before that it is
hidden — the hiding is the design, a dead model is what it prevents. The
model list is read live from the gateway's `/api/v1/models` and refreshes
as the sign-in state changes; when the gateway is unreachable the plugin
falls back to the built-in 2026-10-28 snapshot (chat models only). Bearer
auth on the gateway calls is injected by the host itself. The rows carry
the vendors' own display names — a model the name table doesn't know
keeps its cleaned gateway name with the leading brand word set right —
and the reasoning efforts each vendor's own docs vouch for, intersected
with the gateway row's `reasoning_efforts` declaration (the gateway
serves every thinking row the same five values, but the vendors' pages
say otherwise: DeepSeek's medium/xhigh are aliases of high, Qwen's high
is xhigh, Kimi K2.6 has no effort parameter at all — only none's
turn-it-off). The picker's Default sends no field and the gateway's own
default gear applies.

### Points in the TUI, and the daily renewal

Type `/loomy` (or find "Loomy 积分面板" in the command palette) for a small
panel: the sign-in state, the points total, and the daily grant with its
remaining over its size and its reset moment in Beijing time — with
**check in now** (the same first-login call the Check in now button makes,
worded the same way) and **refresh** beside them. The day's renewal also
runs by itself: at load, behind every credential event and on a half-hour
timer, the same once-a-day claim goes out silently — a success is marked
per Beijing day, a failure just waits for the next event or tick to ask
again. The desktop OpenCode carries the same panel in its own windows —
entry is the desktop's side-panel launcher, through the package's
`./gui-experimental` bundle — and that export name is the upstream's own
admission: the GUI plugin API is experimental and may change between
desktop releases.

### What stays magpie-only

The Usage card, the check-in switch and the image-generator roster ride
magpie's own host-extension hooks — those stay magpie-only, while the
`/loomy` panel above brings the points' numbers to the v2 TUI itself.
There the plugin is the phone-code sign-in, the live model list, the
gateway chat, and the panel.

## Signing in

The sign-in is Loomy's phone-code one, in two steps:

- magpie asks for the phone number first (mainland China, 11 digits; a leading
  `+86` or `86`, spaces and hyphens are cleaned off before the check);
- the plugin sends the SMS code (it lives five minutes), magpie opens a
  six-digit code box, and the plugin trades the code for the session.

The session lasts fourteen days and Loomy offers no refresh. When it ends
(HTTP 401/403, or the business codes `020002`/`100002`), the plugin marks
the sign-in expired and magpie asks for a new SMS sign-in — there is nothing
to renew. The account's id is the masked phone (`138****8000`); the Loomy userid
is kept with the credential.

The account host checks an HMAC-SHA1 signature on both sign-in calls.
The signature belongs to the account plane alone — the gateway
planes never sign.

## Requests

Chats are OpenAI Chat (`@ai-sdk/openai-compatible`) sent to
`https://loomyad.xunfei.cn/api/v1/chat/completions`, the request body passed
through untouched. The session token rides in both headers the gateway reads —
`token:` and `Authorization: Bearer`, the client's own dual write.

A refusal whose words say the points or quota ran out (a 402, 403 or 429 that
says so) goes on as a 429 `rate_limit_error`, so magpie can move the
conversation to another account. Any other 401/403 is the sign-in's end.

## Models

Signed in, the model list is read live from `GET /api/v1/models`: capabilities
become the tool / reasoning / image bits, the context and output limits pass
through, and every model carries the low/medium/high reasoning-effort
variants. The gateway prints each model's point rate as a suffix on its
display name (`MiniMax M3 （x4.0）` — ASCII and full-width brackets both
occur); the plugin splits that off — the name stays clean, and the rate
rides the model record, the field the host's picker reads the multiplier
from. A model the
upstream itself declares free — the words 免费 in the name, or a rate of
exactly zero — carries a `free` bit; no rate at all is not free. Rows that
aren't chat models stay off the chat list — the image generators say so in
their `type`, and carry an image generator's name besides, read by the same
words the host's own image-model catalog reads, so a row that ships no
`type` at all stays off just the same: chatting into one is a failure.

The image generators come back beside the chat list from a roster the
plugin itself keeps — the three it vouches for, each under the display
name the roster gives it, with the live row's own facts (the limits, the
capability bits) riding beside. An entry is in the table only while the
live catalog names its id: a generator Loomy retires leaves at the next
answer with no release needed, and a generator it adds waits for the
release that names it here. No entry is in the fallback tables — with no
live answer there is no proof a generator still exists, and a dead draw
entry is what the roster exists to prevent. On the host side a listed
generator lands in the provider's Image models row when its id is one the
host's own image-model catalog reads (`qwen-image`, `seedream`… —
`Hy-Image` is not among those words), and until the host learns to keep a
plugin's generators out of the chat list too (yetone/magpie#2792) they
show there as chips as well: leave them unticked, and no agent chats into
one.

The live list is the source of truth and wins the moment it answers. Without
a session, on an empty answer or a failed ask, the plugin falls back to the
built-in table in the code — a snapshot of this same catalog's text models
as measured on 2026-10-28, aging only as the gateway's own catalog moves
on; the snapshot's rates and free bits go back to the host with it, and a
failed ask is marked as one, so the editor knows the list is the plugin's
defaults and not the account's. The table below is what the gateway itself
served on that day, kept here as a field guide:

| Model | Display name | Rate | Notes |
|---|---|---|---|
| `spark-x2.6` | Spark-X2.6 正式版(限时免费) | x0.0 | thinking |
| `spark-x` | Spark-X2.5（限时免费） | x0.0 | thinking |
| `DeepSeek-V4.1-Flash` | DeepSeek V4.1 Flash | x2.0 | thinking, image |
| `MiniMax-M3` | MiniMax M3 | x4.0 | thinking, image |
| `Kimi-k2.6` | Kimi k2.6 | x6.5 | thinking, image |
| `qwen-3.8-max` | Qwen 3.8 Max | x12.0 | thinking |
| `GLM-5.3-Flash` | GLM 5.3 Flash | x0.8 | thinking, image |
| `qwen3.8-flash` | qwen 3.8 flash | x0.8 | thinking, image |
| `mimo-v2.5` | MiMo V2.5 | x3.3 | thinking, image, audio |
| `auto` | 自动 · 均衡 | — | the gateway's own router |
| `Hy-Image-3.5-preview` | Hy image 3.5 preview | — | image generation |
| `doubao-seedream-5-lite` | Doubao seedream 5 lite | — | image generation |
| `qwen-image-3.0-pro` | qwen image 3.0 pro | — | image generation |

The three image-generation rows declare `output_modalities: ["image"]` —
they draw pictures rather than answer in text, and how their answers ride
the chat endpoint is unverified. What a model's editor chip says beside an
older build's list: a generator ticked then and unticked now is the
roster's entry back again, no longer a pick the list has forgotten.

## Usage

The usage card shows the two wallets Loomy keeps:

- the balance line: permanent + daily grant, added together (the answer's
  own total when it names one);
- a daily-grant window: the grant's consumed share as its percentage, with
  what is left over the limit beside it. `dailyBalance` is the grant's
  *remaining* (`dailyQuota` − `dailyConsumed`), so the percentage needs the
  grant's size: the pair the answer carries when it carries one, else the
  `dailyQuota` the check-in notes per account — the note lives on the
  credential itself (the host's own store, carried across plugin upgrades;
  a small file beside the plugin stands in where the host has no such
  store). A card that finds no note anywhere asks the first-login answer
  itself — once, the call being idempotent for the day (the client makes it
  on every login) — so a fresh install heals on its first render instead of
  waiting for the next check-in; no share is invented and no quota is
  assumed. The wording follows the interface language the host keeps in
  its settings (Chinese, or English beside it). The window carries the cycle's exact reset
  moment — the next Beijing midnight of the day the check-in's answer named
  — so the card counts down to the real refill, not a guessed one;
- the permanent row set aside: the permanent balance, which has no window;
- the newcomer row beside them: the one-time newcomer tasks (10000 points
  in all) while any stand unclaimed — an aside, never a percentage: a
  purse spent once has no window to consume. The check-in claims them;
  until it runs, the row says what is still claimable.

Loomy has no dedicated balance or check-in endpoint: the summary rides on the
points-records call, and the "check-in" is the first-login call the Loomy
client itself makes on every login. The server renews the daily grant once a
day, and the answer's `alreadyProcessed` tells the day's renewal from a
repeat: a repeat reports *done* ("今日已刷新", with what is left of the grant),
and the day's first reports *claimed* — with the gain as its credit when the
answer carries the whole arithmetic (`dailyQuota` − `dailyConsumed`), and the
remaining in the message otherwise.

## Check-in

The automatic daily run is magpie's, not the plugin's: the **Daily check-in**
switch lives in Settings → Usage → Plugins, ships with **magpie ≥ v0.1.1083**
and is **off by default** — turn it on and magpie runs the refresh once a day
per account (only a failed outcome retries that day). The **Check in now**
button runs it then and there. OpenCode doesn't call this hook.

The same run also claims the one-time newcomer tasks (the eight worth 10000
points in all): serially, highest value first, idempotent — and a refusal
among them never touches the daily claim's own result. The first check-in of
a fresh account typically refreshes the grant and lands the newcomer purse
in one go.

## Known limits

- **The session is fourteen days, with no refresh.** When it ends the only way
  on is a new SMS sign-in.
- **The point rate exists only as the display name's suffix.** Loomy ships no
  structured rate field; the plugin splits the suffix off but cannot verify
  any amount against the catalog.
- **Image input differs per model family.** Verified on the earlier catalog's
  `deepseek-v4-flash-0731` (since retired): it read only the gateway's
  private `<image_base64>…</image_base64>` marker (a standard `image_url` is
  cut off as text), while the GLM models are the opposite — only `image_url`,
  and the marker breaks them. The rewrite is a planned second iteration;
  until it lands, image input is reliable on the GLM family alone, and the
  newer `DeepSeek-V4.1-Flash` declares image input whose shape on this
  gateway is unverified.
- **`reasoning_effort` is ignored on non-thinking models.** Every model
  carries the low/medium/high variants the way the client hangs them; the
  upstream drops the field on the models that don't think — a known behavior.
  Which models think is whatever the live catalog declares — on 2026-10-28
  most text models did, not only the spark pair.
- **Streaming tool calls are not yet verified on a real account.** The
  desktop gateway's tool_calls streaming has no recorded real-machine run
  behind it; it is the first thing to check with your agent's tool loop. If
  it fails, the toolcall bit gets turned down in a future release.
- **The newcomer tasks are claimed by the check-in.** The eight one-off
  tasks (10000 points in all) are queried and claimed on every check-in —
  serially, highest value first, and idempotent: a repeat answers
  `alreadyCompleted` and pays nothing twice. A refusal among them never
  touches the daily claim's own result, and their still-claimable sum shows
  on the card as an aside row while any stands. The upstream judges
  completion its own way; the keys and values are the client's own task
  registry's.

## Disclaimer

This is an unofficial community package. It has nothing to do with iFlytek or
Loomy. The implementation is reverse-engineered from the desktop client's own
behavior and measured against it, for personal study and research. Your
phone number, your code and your session go only to Loomy's own hosts. The
points are for Loomy's own services; Loomy's terms decide where else they
may be used, and iFlytek hasn't approved that. The risk to the account is
yours. An upstream protocol change can break the package at any time.

## Development

```sh
node --test                       # the unit tests (node:test, a local fake upstream, no network)
node scripts/check.node.mjs      # the shape check, the same logic the community CI runs
```

The plugin itself is one `index.mjs` with no runtime dependencies — only
`node:crypto` and the standard `fetch` — and loads in Bun and Node ≥ 20.11
alike.
