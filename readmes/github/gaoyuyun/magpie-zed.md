# magpie-zed

**Upstream's Zed plugin for magpie, with fixes that haven't landed there yet**
— see [NOTICE.md](./NOTICE.md) for what this fork adds and how it follows
[magpie-community/plugins](https://github.com/magpie-community/plugins/tree/main/packages/zed).
Install it in magpie with:

```sh
magpie plugin add github:gaoyuyun/magpie-zed
magpie plugin off @magpie-community/opencode-zed-auth@latest   # if upstream's is installed
```

The rest of this README is upstream's.

---

## @magpie-community/opencode-zed-auth

Signs in to a **Zed** subscription (Zed Pro, its trial, a student or business
plan) and calls the models Zed hosts: Anthropic's, OpenAI's, Google's and
xAI's, through `cloud.zed.dev`, the way the Zed editor calls them. Provider
id: `zed`. Ported from magpie's built-in Zed account.

## Sign-in

**Sign in with Zed (browser)** is Zed's own sign-in:

1. The plugin makes an RSA-2048 key and listens on a port of `127.0.0.1`.
2. The browser opens `zed.dev/native_app_signin` with that port and the
   key's public half.
3. Once you sign in, zed.dev sends the browser back to the port with your
   user id and an access token encrypted to the key. The browser is then
   sent on to zed.dev's "signed in" page.
4. The plugin asks Zed who the account is (`/client/users/me`). That gives
   the organization the models are called under, and its plan. An
   organization with Zed's hosted models turned off is refused.

## Organization

Zed asks for a model token per organization. The Zed editor starts in the
account's default organization and lets you switch to another from its
title bar. The plugin has no switcher, so it picks the organization with a
plan that calls models (any plan but Free), in this order (#232):

1. the organization it saved before, while that one still has such a plan;
2. the default organization, if it has one;
3. the personal organization, if it has one;
4. any other organization that has one.

When none has such a plan, it keeps what Zed picks: the saved organization,
else the default, else the first. The plan shown is the picked
organization's own (none when Zed lists none for it), never the account's
plan in its place. When Zed answers 402 for the organization a sign-in was
saved under ("Organization does not have an active subscription"), the
plugin reads the account again, moves to an organization with a plan if
there is one, saves it with the sign-in, and asks once more. The plan card
re-checks the organization the same way.

The sign-in is kept as an `oauth` entry: `access` is the access token and
`refresh` is JSON holding the user id, machine id, organization and plan.
Zed has no refresh token, so the token lasts until Zed refuses it. When
Zed refuses it, you are asked to sign in again. `accountId` is the account's
GitHub login.

## Requests

- **Model token:** each request uses a short-lived model token, minted from
  the sign-in with `POST /client/llm_tokens` and kept in memory. If Zed calls
  the token stale (a 401, `x-zed-expired-token` or `x-zed-outdated-token`),
  it is minted again once.
- **API per model:** each model is declared on the AI SDK package of its
  own provider, so the request the SDK writes is already what Zed wants.
  The plugin's `fetch` wraps it as `{provider, model, provider_request}` and
  sends it to `POST /completions` with Zed's headers:

  | Zed provider | AI SDK package | API |
  |---|---|---|
  | anthropic | `@ai-sdk/anthropic` | Messages |
  | open_ai | `@ai-sdk/openai` | Responses |
  | x_ai | `@ai-sdk/openai-compatible` | chat completions |
  | google | `@ai-sdk/google` | generateContent |

- **Thread and prompt:** like Zed's editor, each request names its
  `thread_id` and `prompt_id`. The thread comes from the conversation's
  session (or, without one, its first user message), so every turn of one
  conversation is one thread. The prompt changes with each message the user
  sends and stays the same through the tool calls that answer it. Both are
  UUIDs hashed with a per-process salt, so they name nothing they were made
  from.
- **Request changes, as magpie makes them:**
  - Anthropic: the request loses `stream`, since the cloud always streams.
    Every `tool_result` gets `is_error` (Zed's cloud refuses one without it).
  - xAI: `max_tokens` becomes `max_completion_tokens`.
  - Gemini: the model is named in the request as `models/<id>`.
    `thinkingConfig.thinkingLevel` is sent uppercase (`HIGH`) and
    `toolConfig.functionCallingConfig.mode` lowercase (`auto`), the only
    spellings Zed's cloud parses. A model's effort variants are keyed
    lowercase (`low`, `high`) whatever case Zed's model list uses.
- **Replies:**
  - Zed's newline-delimited lines are sent back as each API's own
    server-sent events.
  - A caller that didn't ask for a stream gets one whole reply.
  - A failure Zed reports mid-stream keeps its status (429, 402, 529 …).
    So does a reply without Zed's `stream_ended`, which comes back as an
    error rather than a shorter answer, except one case. A streamed xAI
    (chat) reply that has already said something, and has no tool call
    half written, ends cut short instead, with a note saying so, a `stop`
    and `[DONE]` (#91). magpie's gateway can go on with an Anthropic or
    Responses reply cut short, but not with a chat one.
  - A 402 means the plan doesn't include Zed's hosted models, or its
    allowance is used up.

## Models

- **After sign-in:** the account's own list comes from Zed's `GET /models`,
  read when you sign in and every 10 minutes after. Disabled models are
  left out. Each model's effort levels become its variants. When a read
  fails, the list read last is kept; when none was ever read (Zed down,
  or a list with nothing callable, as for an organization without an
  active subscription), the hook throws why, and magpie shows that reason
  with the account, the declared models marked as not its list (#229).
- **Before sign-in:** the config hook declares one model of each family
  (Claude Sonnet 5, Opus 5.5, Haiku 4.5, GPT-5.5, Gemini 3.5 Flash,
  Grok 4.7), which the account's list replaces.

## Usage

magpie's `auth.usage` hook shows what Zed tells its editor of the plan,
as magpie's built-in Zed account did. Zed doesn't report how much of the
allowance is spent, so there are no windows unless a web session was
given (see Dollar usage below):

- the plan's name (Pro, Pro Trial, Business, Student, VIP). A free
  account's card says "No plan"; its account row still names it Free;
- when the billing period ends;
- an overdue invoice, as the card's error ("its models are paused");
- a sign-in Zed refuses (`/users/me` or the model list answering 401)
  marks the account as needing to sign in again. A plan that changed is
  saved with the sign-in.

## In magpie, not the plugin

These come from magpie itself, as they did for the built-in:

- Several Zed accounts at once. magpie keeps a sign-in per account and
  switches between them; plain OpenCode keeps one sign-in per provider.
- Web search. A model that can't search is given magpie's web-search
  stand-in, when a search API is set up in magpie.

## Dollar usage (optional)

Zed's editor API tells the plan and its period, not what has been spent —
but the account page on zed.dev does: `GET /frontend/billing/usage`, asked
with the browser's own session cookie, answers the period's spend in cents
(`token_spend.spend_in_cents`) and its spending limit. The editor's
sign-in can't read that page (it answers 401), so the sign-in asks for the
web session as an optional extra: a `zed.session` cookie pasted from the
browser's devtools on zed.dev, signed in as the same account — the value
alone, `zed.session=…`, or a whole Cookie request header. Without it the
card is as before, and the billing page is not asked.

With it, the card gains the period's allowance — "Token spend $0.25 /
$10.00", the window carrying the dollars so magpie says it in its own
number format — which counts like any other subscription's: spent to its
limit, magpie holds the account until the period ends and the spend
starts again, as it does a Codex account's window. A web session that has
run out is a line on the card ("the web session has expired: …"), never
an error and never a mark on the account: the editor
sign-in is a separate one and stays fine. A reply that can't be read, or
a spend with no limit told, holds nothing — the first is no line at all,
the second only shown.

The session is kept beside the sign-in pair and, like it, lasts until the
page refuses it. An account signed in already, or whose session ran out,
gets one with **Add a web session to a signed-in Zed account**, with no
sign-in again: it asks the session (and which account, when there are
several), checks it against zed.dev, and keeps the account's sign-in as it
was. It knows the accounts magpie has read since it started, so refresh
the account's usage first if magpie has just started.
It is an undocumented contract of zed.dev's account page, watched since it
changed last.
