# @magpie-community/opencode-cursor-auth

Signs in to a [Cursor](https://cursor.com) subscription (Pro, Pro+, Ultra,
Teams) and makes its requests on the API `cursor-agent` talks to, in
OpenCode and in magpie. Provider id: `cursor`.

## Signing in

An account is a Cursor access token. There are three ways to get one:

- **Cursor (browser)**: the sign-in `cursor-agent login` does. The page
  `cursor.com/loginDeepControl` is opened with a PKCE challenge, and the
  plugin polls `api2.cursor.sh/auth/poll` until the browser has signed in.
  The account is named by its email (`DashboardService/GetMe`).
- **cursor-agent's sign-in**: takes the account `cursor-agent login`
  signed in to. Its token is read on every request from where the CLI
  keeps it: the macOS keychain (`cursor-access-token`), else its
  `auth.json` (`~/.cursor/`, `$XDG_CONFIG_HOME/cursor/` or
  `%APPDATA%\Cursor\`). The plugin never writes it; when it has less than
  5 minutes left, `cursor-agent status` is run, which renews it.
- **Cursor API key**: a key from cursor.com/dashboard → Integrations. It is
  exchanged for a token at `/auth/exchange_user_api_key`, as the CLI does
  with `CURSOR_API_KEY`, and exchanged again when the token runs out.

Sign-ins are kept where OpenCode keeps them (`auth.json`; in magpie,
`plugin-auth.json`). A browser sign-in's token lasts about two months.
Cursor gives the CLI no way to renew it, so after that you sign in again.

## Requests

OpenCode speaks chat completions (`@ai-sdk/openai-compatible`); the
plugin's `fetch` answers them on Cursor's agent API:

- The agent API is the one `ServerConfigService/GetServerConfig` names for
  the account (a team may be served in one region only), else
  `agentn.global.api5.cursor.sh`. A refusal that names a region is tried
  once more with the config asked again.
- Each request is one `agent.v1.AgentService/Run`, a Connect stream both
  ways over HTTP/2, with the CLI's headers (`x-cursor-client-type: cli`,
  its version, privacy mode on).
- Where HTTP/2 can't open a Run (an error before its response, or none in
  15 s: a proxy or network that blocks HTTP/2), it goes as Cursor's clients
  run it without HTTP/2: `agent.v1.AgentService/RunSSE` down and a
  `aiserver.v1.BidiService/BidiAppend` for each client message up, over
  HTTP/1.1 on `api2.cursor.sh`, through the proxy magpie gives the request.
  When the failure says HTTP/2 itself can't be had (no head in 15 s,
  "h2 is not supported", no HTTP/2 in ALPN, a protocol error), the Runs
  after it go straight to HTTP/1.1 for 10 minutes; a failed connection
  (refused, no network) or a stream the server refused leaves the next Run
  to try HTTP/2 again. A region error over HTTP/1.1 sends the Run back to
  HTTP/2 at the region's agent host. A BidiAppend with no answer in 60 s
  (more for a large one) ends the Run, as cursor-agent does.
- The whole conversation goes each time, as AI SDK messages kept as blobs
  the server asks for. The caller's tools are MCP tools, listed in the
  system prompt; the model calls them through Cursor's `CallDynamicTool`,
  and the calls come back as chat completion tool calls. Cursor's own tools
  (shell, file reads, edits) are never run.
- A conversation's Runs share one `conversation_id`, so Cursor sends them
  to the machine that has the prompt cached (Grok on Cursor caches by
  machine). It is made from what names the session — the request's
  `prompt_cache_key` (Codex's thread id), else the session the
  `chat.headers` hook is told — and the conversation's first user message,
  so subagents under one session are conversations of their own. With
  nothing naming the session, each Run has a new one.
- Text, thinking (`reasoning_content`) and token usage come back streamed
  or not. Cursor's `input_tokens` counts the cached prompt too: the cache
  read and written is taken out of it, and given as `cached_tokens` and
  `cache_write_tokens`, so it is counted once; its reasoning tokens are
  `reasoning_tokens`. A step that calls tools gets no usage in its Run
  (Cursor tells it only once the tools' results come back in the same
  Run), so once the Run is closed its usage is read from the dashboard's
  usage events, by the Run's conversation id: it shows in about 2.5 s,
  and is looked for up to 6 s. Far from Cursor it shows later than that
  (yetone/magpie#1053), so the step says 0 used and the conversation owes
  it: its next steps collect the event in the background and count it
  with their own, and a step that ends the turn waits for what is still
  owed, so the conversation adds up to what Cursor counted. An account
  whose events miss the wait 3 steps in a row stops waiting for them.
  With nothing naming the session (so no later step to collect it), or
  an account that can't read its usage events, the step is estimated as
  before.
  Failures keep their statuses: 401 to sign in again, 429 at the
  usage limit, 400 for a prompt too long, 403 for a region refusal.

## Models

The `config` hook declares `auto` (Cursor's pick). Once signed in, the
`provider.models` hook lists the account's models from Cursor's model
picker (`AiService/AvailableModels`, as the CLI asks for it, cached 10
minutes), the way pi-cursor-sdk lists Cursor's catalog:

- A model with a `context` parameter is listed once per size, as
  `<model>@<size>` named `<name> @ <size>` (`claude-opus-5-5@300k`,
  "Claude Opus 5.5 @ 300k"), its window that many tokens. A model with none
  is listed once, its window Cursor's `contextTokenLimit` (Max Mode's for a
  model served only in Max Mode); 200K when Cursor gives none.
- Effort is not a model of its own: the model's efforts are its variants,
  and the request's `reasoning_effort` (fitted to the nearest there is) is
  sent as the model's effort parameter. `none` turns a Claude's thinking off.
- Fast is not a model of its own either: a `service_tier` of `priority`
  or `fast` sends `fast=true`, anything else `fast=false` (it costs more,
  so only when asked). A model listed at a size Cursor has a fast variant
  of (served to the account) says `fast: true`, which magpie offers its
  Fast switch for (yetone/magpie#1360).
- A request goes as the picker's variant those parameters pick, in Max Mode
  when that variant is Max Mode's (a 1M size, say), as the CLI turns it on.
  A size with no variant goes in Max Mode when it is over Cursor's limit
  outside it. A model Cursor still answers "Max Mode Required" for is asked
  again in Max Mode, and so from then on.
- Hidden, Tab-only and chat-only models stay out, as in the CLI's picker.
- The usable list (`AgentService/GetUsableModels`, what `cursor-agent
  models` shows) says which variants the account has: a variant whose own
  id isn't in it is neither offered nor asked for (Sonnet 4.6 at any effort
  but medium, say), and a request for one goes as the nearest the account
  has. A model the usable list has nothing of is the picker's alone
  (GLM-5.3) and is kept whole; so is every model when Cursor can't give
  the usable list.
- An id from before 0.2.0 still runs. A variant's own id
  (`claude-opus-5-5-high`) is that variant; a family 0.1.x listed
  (`claude-opus-5-5`, `claude-opus-5-5-fast`, `claude-haiku-5-5-thinking`,
  `cursor-grok-4.6`) is its variant nearest the default, fast for a `-fast`
  one; the picker's name for a model or a legacy slug of it is its default.
  Each is at the default context size, the request's `reasoning_effort`
  and `service_tier` counting as for a listed model. The list doesn't show
  these ids: pick the `@<size>` model for a window that is the model's.

## Usage

magpie shows Cursor Models, Other Models and Total for the billing period.
Accounts with a Grok Bot allowance also show its usage and reset time;
active trials are labelled separately. A spent Bot allowance doesn't stop
Cursor requests.

An account that may spend on-demand once its included usage is gone (a
team or personal spend limit, as `cursor-agent`'s usage view shows it) also
shows On-demand: its spend, and its limit when it has one. Cursor keeps
serving such an account past the included usage, so magpie doesn't count
it used up when Cursor Models or Other Models reach 100%; it does when the
on-demand spend reaches its limit.

Sign in to the Cursor account linked in Grok Bot. A linked SuperGrok
subscription grants Bot access without a paid Cursor plan; see
[Grok Bot plans and billing](https://cursor.com/help/grok-bot/plans).

## Not included

- Web search: Cursor's own web search is refused like its other tools.
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- The Responses and Messages APIs: only chat completions are answered.
