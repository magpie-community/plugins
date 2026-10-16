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
  left out. Each model's effort levels become its variants.
- **Before sign-in:** the config hook declares one model of each family
  (Claude Sonnet 5, Opus 5.5, Haiku 4.5, GPT-5.5, Gemini 3.5 Flash,
  Grok 4.7), which the account's list replaces.

## Not included

- magpie's plan display: plan name, billing period, overdue invoices. Zed
  doesn't report how much of the allowance is spent.
- Several Zed accounts at once. OpenCode keeps one sign-in per provider.
- magpie's web-search stand-in.
