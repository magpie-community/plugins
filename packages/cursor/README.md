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

OpenCode and Pi speak Chat Completions; the plugin's `fetch` answers them
on Cursor's agent API:

- The agent API is the one `ServerConfigService/GetServerConfig` names for
  the account (a team may be served in one region only), else
  `agentn.global.api5.cursor.sh`. A refusal that names a region is tried
  once more with the config asked again.
- A new user turn starts an `agent.v1.AgentService/Run`, a Connect stream
  both ways over HTTP/2, with the CLI's headers (`x-cursor-client-type:
  cli`, its version, privacy mode on). Bootstrap imports the caller's
  Chat history as AI SDK transcript blobs. A later new user turn imports
  history into a new Run.
- External tool roundtrips within that turn keep the **same native Run**
  open. The caller's tools are MCP tools, listed in a separate leading
  catalog message and invoked through `CallDynamicTool`. Calls become
  Chat tool calls. Matching results are sent to the original numeric exec
  IDs, followed by exec-close messages. The background reader continues
  storing blobs and checkpoints while the caller runs tools.
- A continuation must keep the accepted history, assistant call batch,
  account credential, model, controls, tool definitions and session
  selector. The current assistant's display reasoning may be omitted;
  previous accepted history must still match. Assistant strings and text/reasoning
  arrays have the same display meaning; split pieces concatenate without added
  separators. All parallel results must arrive together. Divergent or incomplete
  results fail before submission.
  A lost or expired pending owner returns an error rather than starting
  another Run. Completed tool history followed by a new user can be
  imported after retention expires or on another account.
- Ownership is in one plugin process. Tools have 120 seconds to return;
  a Run has a 15-minute absolute lifetime. A completed continuation can
  replay its cached response for up to 120 seconds, with zero usage.
  Retention is bounded to 8 Runs per credential / 32 per process, 64 MiB
  of blobs/checkpoint and 16 MiB of retained request/output per Run.
  Admission preserves unrelated active Runs. Cancellation closes the
  owned transport, including one that finishes opening after cancellation.
  Cancelling a cached replay leaves the active Run and later batch intact.
  Cancellation cannot stop external tools already handed to the
  Chat client. Host restart, account changes or compaction of pending
  history do not provide recovery. Do not rely on exactly-once external
  tool execution; local result submission is at most once while retained.
- Where HTTP/2 can't open a Run (an error before its response, or none in
  15 s: a proxy or network that blocks HTTP/2), it goes as Cursor's clients
  run it without HTTP/2: `agent.v1.AgentService/RunSSE` down and a
  `aiserver.v1.BidiService/BidiAppend` for each client message up, over
  HTTP/1.1 on `api2.cursor.sh`, through the proxy magpie gives the request.
  Appends are serialized and numbered, including result before exec close.
  The shared HTTP/1 and HTTP/2 sender bounds queued and in-flight Connect
  frames to 16 MiB / 256 messages per Run, including KV replies and both
  heartbeats. It waits for write completion and drain; an HTTP/1 write
  completes after its append. Queue overflow fails the owner with 503.
  HTTP/1 hex/envelope encoding adds transient memory for one active append.
  When the failure says HTTP/2 itself can't be had (no head in 15 s,
  "h2 is not supported", no HTTP/2 in ALPN, a protocol error), the Runs
  after it go straight to HTTP/1.1 for 10 minutes; a failed connection or
  refused stream leaves the next Run to try HTTP/2 again. A region error
  over HTTP/1.1 sends the Run back to HTTP/2 at the region's agent host.
  A BidiAppend with no answer in 60 s (more for a large one) ends the Run.
  A result with an uncertain transport outcome is never resubmitted.
- A conversation's new Runs share a `conversation_id` for cache routing.
  It is made from the request's `prompt_cache_key` (Codex's thread id),
  else the session the `chat.headers` hook is told, and the first user
  message. With neither, each new Run has a new id; pending calls still
  route by their process-local handles. Routing IDs do not make a
  conversation durable.
- Ordinary text and thinking (`reasoning_content`) stream progressively.
  Tool calls are withheld until the complete batch validates. With
  `tool_choice: "required"`, a named choice or
  `parallel_tool_calls: false`, all step output waits for validation;
  that adds latency and has a 16 MiB buffer bound. A late failure can end
  an ordinary stream after some display text, but exposes no invalid
  tool batch. An error known during prefetch returns its actual HTTP status
  before the streaming response is created. Later failures arrive as SSE
  errors. Nonstreaming requests collect the validated reply.
- Tool handoffs report zero tokens with
  `usage.magpie_native.accounting: "pending"`. Final native totals are
  reported once, including explicit zero. `prompt_tokens` includes cached
  input once; `cached_tokens`, `cache_write_tokens` and `reasoning_tokens`
  retain their native counts. Missing input/output fields may be
  estimated, marked `accounting: "estimated"`; cached retries are marked
  `"replayed"`. This path does not close Runs to poll dashboard events or
  emit the legacy `magpie_deferred` debt. Failed or cancelled Runs may
  have unknown usage.

Failures keep their statuses: 401 to sign in again, 429 at the usage limit,
400 for invalid input or a prompt too long, and 403 for a region refusal.
Invalid Chat input is checked before authentication; a valid request with
an unusable sign-in remains a 401. Every response keeps the account's
sign-in (`X-Magpie-Sign-In: kept`).

## Chat input policy and diagnostics

System instructions keep their original position. Developer messages use
system-role equivalence in place, with a `developer_as_system` advisory.
Assistant history accepts `reasoning_content`, `reasoning` and
`reasoning_text`, in that precedence; different shadowed aliases produce
advisories. Explicit reasoning parts and split assistant tool-call
messages retain their text and reasoning. Imported display reasoning is
not a native thinking signature or checkpoint.

User and tool messages accept text and base64 data images (PNG, JPEG, GIF,
WebP), preserving part order. The image limit is 10 MiB each / 20 MiB per
request, subject also to the request retention bound above. Encoding and
MIME signatures are checked, not full image decoding. Remote URLs, files,
audio, video and unknown parts return field-specific 400 errors. Tool
results preserve supplied `is_error` / `isError`; conflicting flags fail.
Flags omitted by a client converter cannot be recovered by the bridge.
Pi's exact user suffix `Attached image(s) from tool result:` followed only
by images joins the preceding single complete tool result, preserving
image order. Pi's parallel aggregation has no call attribution and returns
a field-specific 400: put each image directly in its matching tool message.
Extra/new user text and incomplete batches remain rejected while results
are pending. Tool names
use 1–64 letters, digits, underscores or hyphens; call IDs use 1–512.
Arguments must be valid JSON objects. Native protobuf Value/Struct/List
arguments are decoded recursively with complete-tail and typed-field
checks, a 1 MiB message bound, 100,000 fields and 64 nesting levels;
legitimate protobuf defaults are preserved. Every MCP argument envelope
validates before exec processing. Repeated envelopes with differing decoded
tool identity or arguments return 502 because their selection/merge semantics
are unsupported; identical decoded calls produce one tool call. Duplicate
calls and orphan or duplicate results fail instead of being dropped.

`tool_choice: "none"` supplies no current tools while preserving historical
calls. `required` and named choices require a call in the completed step;
`parallel_tool_calls: false` allows at most one. Invalid model output
cancels and evicts the owner. Supplied argument schemas are forwarded;
strict schema validation is unsupported.

| Option | Policy |
| --- | --- |
| `temperature`, `top_p` | Range-checked and ignored; advisory has `enforced: false`. |
| `max_tokens`, `max_completion_tokens` | Positive integers accepted and ignored; **token caps are NOT enforced**. |
| `reasoning_effort` | Uses picker parameters; actual fitted effort is disclosed. Thinking-only on maps exactly to `high`, off to `none`. Explicit `none`/`off` requires a served off variant. |
| `service_tier` | `priority`/`fast` select fast; recognized other tiers select standard service with a scheduling advisory. |
| `prompt_cache_retention`, `user`, `safety_identifier`, `metadata` | Validated and ignored with advisories. |
| `stop`, `response_format`, `seed`, logprobs, token bias, penalties, `n`, tool `strict` | Nonempty stop, JSON/schema formats, any seed, positive logprob requests, nonempty token bias, nonzero penalties, multiple completions and `strict: true` are rejected. Inert defaults such as empty stop, text format, zero penalties and `strict: false` are accepted. |

Unknown request fields and unsupported constraints fail explicitly. Valid
Pi/OpenCode streaming, usage options, function tools and image requests
use this same policy.

JSON replies include `magpie_cursor` with `policy_version`,
`effective_model: {id, parameters, max_mode}`, `advisories` and `continuity`.
Streams include it in the first assistant chunk. Each advisory contains
`field`, `code`, `message` and `enforced: false`. Headers also expose
`X-Magpie-Cursor-Model` (JSON) and `X-Magpie-Cursor-Continuity`:

```text
same-run; bootstrap=imported-history; new-turn=stateless; restart=unsupported
```

Contract input errors include machine-readable `error.code` and `error.param`;
unsupported explicit off uses `unsupported_reasoning_effort` at
`reasoning_effort`. See [DIFFERENCES.md](./DIFFERENCES.md) for the boundaries
between this bridge and `cursor-agent`.

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
  sent as the model's effort parameter. Explicit `none` or `off` requires
  a served variant that disables thinking at the selected context and
  tier; otherwise it returns 400. `none` is advertised only where a
  served off variant exists. The observed Opus/Sonnet 5.5 picker has no
  off variant; Haiku 5.5 has `thinking=false` variants. The catalog uses
  metadata rather than a blanket Claude override; refresh it after an
  update so clients receive the available variants.
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
on-demand spend reaches its limit. A team member with no limit of their
own spends the team's pool: On-demand shows the pool's spend and limit,
with the member's own spend beside it, and the account is used up when
the pool is.

Sign in to the Cursor account linked in Grok Bot. A linked SuperGrok
subscription grants Bot access without a paid Cursor plan; see
[Grok Bot plans and billing](https://cursor.com/help/grok-bot/plans).

## Not included

- Web search: Cursor's own web search is refused like its other tools.
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- The Responses and Messages APIs: only chat completions are answered.
