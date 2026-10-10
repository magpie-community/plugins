# @magpie-community/opencode-zed-auth

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
   the organization the models are called under: the default one, else the
   first. It also gives the plan. An organization with Zed's hosted models
   turned off is refused.

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

- **Request changes, as magpie makes them:**
  - Anthropic: the request loses `stream`, since the cloud always streams.
    Every `tool_result` gets `is_error` (Zed's cloud refuses one without it).
  - xAI: `max_tokens` becomes `max_completion_tokens`.
  - Gemini: the model is named in the request as `models/<id>`.
- **Replies:**
  - Zed's newline-delimited lines are sent back as each API's own
    server-sent events.
  - A caller that didn't ask for a stream gets one whole reply.
  - A failure Zed reports mid-stream keeps its status (429, 402, 529 …).
    So does a reply without Zed's `stream_ended`, which comes back as an
    error rather than a shorter answer.
  - A 402 means the plan doesn't include Zed's hosted models, or its
    allowance is used up.

## Models

- **After sign-in:** the account's own list comes from Zed's `GET /models`,
  read when you sign in and every 10 minutes after. Disabled models are
  left out. Each model's effort levels become its variants.
- **Before sign-in:** the config hook declares one model of each family
  (Claude Sonnet 5, Opus 5.5, Haiku 4.5, GPT-5.5, Gemini 3.5 Flash,
  Grok 4.7), which the account's list replaces.

## Not included

- magpie's plan display: plan name, billing period, overdue invoices. Zed
  doesn't report how much of the allowance is spent. (The dollar spend,
  when a web session is given, is — see below.)
- Several Zed accounts at once. OpenCode keeps one sign-in per provider.
- magpie's web-search stand-in.

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
run out is a line on the card ("add the web session again to see dollar
usage"), never an error and never a mark on the account: the editor
sign-in is a separate one and stays fine. A reply that can't be read, or
a spend with no limit told, holds nothing — the first is no line at all,
the second only shown.

The session is kept beside the sign-in pair and, like it, lasts until the
page refuses it; when it does, sign in again and paste the session then.
It is an undocumented contract of zed.dev's account page, watched since it
changed last.
