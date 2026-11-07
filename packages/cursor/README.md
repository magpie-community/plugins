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
  signed in to. Its token is read from where the CLI keeps it: the macOS
  keychain (`cursor-access-token`), else its `auth.json` (`~/.cursor/`,
  `$XDG_CONFIG_HOME/cursor/` or `%APPDATA%\Cursor\`). A keychain read is
  kept for 10 seconds, and one the keychain refused (the user said no to
  its dialog) is not asked again for 10 minutes; signing in reads it
  afresh. The plugin never writes it; when it has less than 5 minutes
  left, `cursor-agent status` is run, which renews it.
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
- A fresh request opens `agent.v1.AgentService/Run`, a Connect stream both
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
  HTTP/2 at the region's agent host. BidiAppends go up numbered in order,
  up to 16 at a time as cursor-agent sends them. A native session's Run
  sends only its KV replies (the history's blobs) that way; a tool result
  or anything else waits for the appends before it, goes alone, and is
  written once Cursor answered it, so it is never uncertain. A BidiAppend
  with no answer in 60 s (more for a large one) ends the Run, as
  cursor-agent does.
- A new Run imports the whole conversation as AI SDK messages kept as blobs
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
  or not. Replayed assistant `reasoning_content` (or `reasoning`) is kept as
  AI SDK reasoning parts in the next Run's transcript, including when a
  caller splits parallel tool calls across assistant messages. It stays
  separate from reply text; no thinking signature is invented.
  Cursor's `input_tokens` counts the cached prompt too: the cache
  read and written is taken out of it, and given as `cached_tokens` and
  `cache_write_tokens`, so it is counted once; its reasoning tokens are
  `reasoning_tokens`. A step that calls tools gets no usage in its Run
  (Cursor tells it only once the tools' results come back in the same
  Run), so once the Run is closed its usage is read from the dashboard's
  usage events, by the Run's conversation id: it shows in about 2.5 s,
  and is looked for up to 6 s. Far from Cursor it shows later than that
  (yetone/magpie#1053), so the step says 0 used and the conversation owes
  it: its next steps collect the event in the background, and a step
  that ends the turn waits for what is still owed, so the conversation
  adds up to what Cursor counted. What a step collected of earlier steps
  is not added to its own count, which a client reads as how full its
  context is: it is `usage.magpie_deferred` (`prompt_tokens`,
  `completion_tokens`, `cached_tokens`, `cache_write_tokens`), which
  magpie bills with the step and clients ignore. An account
  whose events miss the wait 3 steps in a row stops waiting for them.
  With nothing naming the session (so no later step to collect it), or
  an account that can't read its usage events, the step is estimated as
  before.
  Failures keep their statuses: 401 to sign in again, 429 at the
  usage limit, 400 for a prompt too long, 403 for a region refusal.

Tool results can continue a retained Run in the same plugin process. The owner
uses the same session/cache key and first user message as `conversation_id`, so
Task subagents sharing their parent's session can run independently. A new
user turn whose earlier native calls all have their results gets a retained Run
of its own, with those calls as imported history; while any of them is still
pending, the turn goes stateless. New input after results already given (a
reminder Claude Code sends beside a tool result reaches the plugin as a user
message after it) also gets a retained Run of its own while a parent Run of
the conversation still awaits results. That Run takes no reservation and
leaves the parent alone; only its own calls' results resume it. Retention
waits at most 120 seconds for a result batch and 15 minutes for a Run's total
lifetime. A continuation arriving with less than 10 minutes of that lifetime
left rebuilds from supplied history on a fresh Run before submitting results
to the old one, since one step can be a long answer. The absolute deadline
still applies to an active segment; it is never extended by activity. A Run
cut by it mid-answer ends with `native Run lifetime expired: the Run timed
out; retry your request`, words agents ask again on.
The pool holds at most 8 owners per account and 32 per process, with
bounded history, blobs, arguments, and pending writes. When pending writes
reach their bound (a long history asks for its blobs at once, and a slow link
drains them slowly), the Run waits for the link to drain, and fails only if it
doesn't for 30 seconds.

A step's calls must all arrive within 30 seconds of each other: Cursor sends
each one once the model has written it, so a step of many long calls can take
longer than that in all (#155).

A Run Cursor stops answering ends with a 502 that says so, retained or
stateless: 60 seconds with no message at all, or 4 minutes with only
Cursor's heartbeats (yetone/magpie#2672, where a Run sent some thinking and
then nothing, and the reply waited until the agent gave up after 5 minutes).
Only time spent waiting on Cursor counts: a retained Run waiting for the
caller's tool results is bounded by the 120 seconds above instead.

Cursor's count of a step's tool calls includes calls the plugin answers itself:
a tool the request doesn't have is refused to the model, and Cursor's own
`get_mcp_tools` is answered with the request's tools. It also includes calls
Cursor completes by itself, which it writes and completes in the step but never
starts on the client or sends to it; those count toward it too. When the count
comes after the step's calls, a checkpoint whose state waits on exactly the
calls the caller was given also ends the step (#550); a checkpoint between
calls after a count sent ahead of them does not seal the batch early. The
step's calls are the rest.

These are retention limits. A missing, expired, restarted, busy, incompatible,
or full owner uses the original history reconstruction and stateless decoder
on a new Run. Pending parent calls can take that path without cancelling the
parent's owner. Already supplied client tool results become
history; the plugin never executes those external tools. A failed native result
write is reported to that request because its outcome may be uncertain. A later
request can rebuild from its supplied history without submitting the result to
the old native exec again.

A native tool handoff reports zero usage with `magpie_native.accounting=pending`;
the final native answer bills the turn's totals. Its own `prompt_tokens` and
`completion_tokens` are its last model call's count (`ModelCallCompletedUpdate`,
asked for with `emit_model_call_usage`, else the larger of that call's prompt
estimate and the turn's mean per call), since a client reads
them as how full its context is; the earlier calls' share is
`usage.magpie_deferred` (#156). An identical completed retry
replays the saved response with zero usage. A native final also collects earlier
stateless debt as `usage.magpie_deferred`, separately from its own prompt total.
If a started native Run is abandoned after a pending handoff, its dashboard
count is owed once to the same account and conversation. Successful final
snapshots, including explicit zero, and cached replays do not enroll that debt.
A Run still awaiting results when a later native Run of its conversation
starts owes that count at once, for the later Run to collect, rather than at
abandonment; what it had collected and not given out goes along. Cursor adds
each step to a Run's one event as the step ends, so that event is looked for
only `owedAt` (5 seconds) after the handover; a final waits for it. If its own
results resume it after all, a count not collected yet is withdrawn, and one
already collected comes off its final (from the earlier calls' share first),
so the event is billed once.

Dashboard attribution uses event timestamps, rather than when events arrive.
Older debt is bounded strictly before the native Run's start, and keeps that
bound across later stateless Runs so an authoritative native event is not
billed again. A Run abandoned after a later native Run of its conversation
started owes with the same bound, before that later start. An earlier event
stamped on or after that boundary cannot be identified reliably and stays
unknown. Missing or ambiguous debt expires after
10 minutes; at most 64 distinct bounded debt groups are kept per account and
conversation, dropping the oldest on overflow. These counts are never guessed
as prior usage. Stateless Runs otherwise keep the dashboard accounting above.
`X-Magpie-Cursor-Continuity` identifies `same-run` or `stateless`, with the fallback
reason where available. A missing native batch count can retry stateless once
before any output is exposed or native result submitted; progressive output is
kept and its later errors are surfaced. A step's declared tool batch waits 30
seconds from Cursor's latest call, count, text or heartbeat, so one long call
written under heartbeats is not cut off; the failure says how many of the
declared calls came.

The existing request builder and model selection remain in use, including the
legacy `thinking=false` mapping for explicit `none`/`off`. Retention adds no
request-field whitelist or strict generation-option validation. Native tool
results preserve ordered text and data-URL images and explicit error flags;
unsupported native result shapes use the legacy history path.

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
- The full catalog (`AvailableModels` with `scope: 3`, asked alongside the
  other two; it also lists the models Cursor hides from an account, Claude
  from a Pro one) supplies the Anthropic models the picker lacks: each live
  one (not `isHidden`, not Auto, not chat-only or Tab-only) with a variant
  the usable list has an id for is listed as the picker's models are, once
  for each context size (`claude-opus-5-5@300k`, `claude-opus-5-5@1m`; name
  "Claude Opus 5.5 @ 300k"), thinking a parameter, the efforts the account
  is served, and the larger size in Max Mode with that `context`. A catalog
  variant without its own id gets the one of the model's ids that says its
  effort, thinking and fast; with none or several it is not offered. Only
  the parameters the model defines are sent (the catalog's variants also
  carry `cyber=false`, which the picker's don't and cursor-agent never
  sends). With no effort asked, a model goes at Cursor's default variant
  (Opus 5 and 4.8: high), as the picker's models do, not at medium as the
  fallback entries did. The picker's models and every model that is not
  Anthropic's don't change.
  An id saved from an earlier list (`claude-opus-5-5`,
  `claude-opus-4-8-thinking@1m`) runs as the model at the nearest size it
  has, as a usable id.
- When Cursor can't give the catalog, a family the usable list has and the
  picker doesn't (`claude-opus-5-5-low` to `-max`) is listed once under its
  family id (`claude-opus-5-5`), its efforts as variants, and goes as the
  usable id those parameters pick, never as the family id Cursor doesn't
  know; it has no window in the usable list, so 200K is assumed. A picker
  model whose chosen variant isn't one the account can use goes as its
  family's nearest usable id the same way. Such a family is named without
  the tier Cursor's names carry ("Claude Opus 5 1M Medium Thinking" is
  listed as Claude Opus 5 Thinking): the tier is the reasoning level the
  agent asks for (low to max, as the account has them), fast the request's
  `service_tier`.
- An id for a model with thinking that the account lists only without it
  (`claude-haiku-5-5-thinking` when the list has Claude Haiku 5.5 alone),
  or the other way round, runs as the model the account has. So does a
  picker model whose default thinks while the account lists it only
  without thinking (`claude-haiku-5-5`), or the other way round: each of
  its variant ids goes as the id the account lists.
- An `@<size>` id the list no longer has (`claude-opus-5-5@1m` when only
  300k is listed, or the model is listed unsized) runs at the model's
  nearest size, in Max Mode when the size asked for is over the model's
  window, never as the literal `@<size>` id.
- An id from before 0.2.0 still runs. A variant's own id
  (`claude-opus-5-5-high`) is that variant; a family 0.1.x listed
  (`claude-opus-5-5`, `claude-opus-5-5-fast`, `claude-haiku-5-5-thinking`,
  `cursor-grok-4.6`) is its variant nearest the default, fast for a `-fast`
  one; the picker's name for a model or a legacy slug of it is its default.
  Each is at the default context size, the request's `reasoning_effort`
  and `service_tier` counting as for a listed model. The list doesn't show
  these ids: pick the `@<size>` model for a window that is the model's.

A chat request picks its variant from the same list without waiting for it
when it needn't: a list past its 10 minutes is used while a new one is
asked for, requests at once share one ask, and after an ask fails requests
go without the list for 5 minutes instead of each waiting for it again.

## Usage

magpie shows Cursor Models, Other Models and Total for the billing period.
A plan of Cursor's merged billing (`GetPlanInfo`'s `isMerged`, the newer
plans) has no Other Models pool: its included usage is one allowance every
model draws on, as the dashboard's "Weekly usage limit" shows it. magpie
shows that as one window, Weekly (Monthly on a monthly plan), for every
model.
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

Free credit shows too, as Cursor's own IDE reads it. The plan's bonus
("+$X free usage on us", `GetCurrentPeriodUsage`'s `bonusSpend` and
`remainingBonus`) is Free usage: what was spent from it this period, and
whether more is left; Cursor gives no amount for it. Each credit grant
(`GetUsageLimitStatusAndActiveGrants`' `activeGrants`, the IDE's "Use your
$X free credits") is a window of its own, named by its campaign: spent of
total, when it expires, and its limits. A grant limited to some models
lists them; one only Cursor's Cloud Agents (or another client) may spend
says so in its name, since magpie talks as `cursor-agent`. While a bonus
or a grant magpie can spend has some left, a spent included pool doesn't
count the account used up for the models it pays for. With "Included
usage only" on, free credit is shown only.

An Enterprise account's period has no Cursor Models, Other Models or Total
in `GetCurrentPeriodUsage`: Cursor reports its overall allowance through
the website's `usage-summary` instead. Magpie shows that as Enterprise,
for example `49.45 / 800 USD · 6.2% used`, or
`750.55 / 800 USD · 93.8% left` with Magpie's Used / Left choice, reset at
the billing cycle's end. When the summary says team on-demand is enabled
and unlimited or still has room, the Enterprise window is informational:
reaching its included allowance doesn't count the account as used up.
On-demand also shows the team's spend when known, with its limit when it
has one. A reached on-demand limit counts the account as used up.

### Included usage only (optional)

In magpie, open the Cursor provider, turn on **Included usage only** under
**Plugin options**, and save (or set `"pluginOptions": {"cursor":
{"included_only": true}}` in magpie's settings.json). It is off by default,
applies to every Cursor account, and takes effect at each account's next
usage reading.

When on, Cursor Models and Other Models (a merged plan's Weekly, an
Enterprise account's allowance) are what keep an account in routing: once one is used up, magpie moves its
models to the next account until the period resets, even when on-demand
could still pay for them. On-demand and Total are still shown but never
keep an account in routing. Use it when on-demand is a shared or paid pool
you don't want spent. When off, on-demand works as described above.

### Wire trace (optional, for bug reports)

In magpie, open the Cursor provider, turn on **Wire trace** under **Plugin
options**, and save (or set `"pluginOptions": {"cursor": {"wire_trace":
true}}` in magpie's settings.json). It is off by default and takes effect
at the next request.

When on, each Cursor request that fails (not one you cancel) saves a JSON
file in the `cursor-traces` folder of magpie's folder: `~/.config/magpie/cursor-traces`
(on Windows `C:\Users\<you>\.config\magpie\cursor-traces`), or the
portable data folder. The newest 20 are kept. A file holds the Run's
frames in order, both ways, as each frame's time (ms from the Run's
start), size, kind (text, thinking, checkpoint, heartbeat, ...), field
numbers and sizes, and the field numbers and sizes one level inside them,
plus the error and the model id. A few of Cursor's numbers are kept too: a
tool count's value, which kind of call (the field number of Cursor's tool
call) a call update is about, how many calls a checkpoint waits on, and,
for a Run that went without the native session, why. No prompt, reply or thinking text, tool
name or argument, blob or checkpoint content, token, header, account or
conversation id is written; the error's message has anything shaped like
an email, id or token taken out. Look the file over before you attach it.

Turn it off again when you're done.

Sign in to the Cursor account linked in Grok Bot. A linked SuperGrok
subscription grants Bot access without a paid Cursor plan; see
[Grok Bot plans and billing](https://cursor.com/help/grok-bot/plans).

## Not included

- Web search: Cursor's own web search is refused like its other tools.
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- The Responses and Messages APIs: only chat completions are answered.
