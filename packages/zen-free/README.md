# OpenCode Zen Free

OpenCode Zen's free models in magpie and OpenCode. Provider id:
`opencode-zen-free`.

Since 2026-10-13 Zen's free tier answers 403 FreeTierError ("can only be
used from within OpenCode") to a request that isn't OpenCode's. From
0.1.6 the plugin sends a free-model request with exactly the headers
OpenCode sends to Zen, and a session id of OpenCode's own form. Older
versions (0.1.1 on npm before it) get the 403: update the plugin.

Since 2026-10-26 Zen's free tier answers `429 FreeUsageLimitError`
("Free models work in OpenCode") to the User-Agent OpenCode 1.19.0 sent,
which 0.1.6 to 0.1.15 sent on every request. From 0.1.16 the plugin
sends OpenCode 2.0.25's headers (`opencode/latest/2.0.25/cli`, its
session id under `x-session-affinity` and `x-session-id` too): update
the plugin.

## Install

```sh
magpie plugin add @magpie-community/opencode-zen-free-auth
magpie plugin login opencode-zen-free
```

## Sign in

Enter `public` in the key field. No personal API key is needed.

Hosts supporting magpie's `keyless` and `single` auth metadata can enable
this public identity without a key field and offer Sign in again instead
of another account. Older hosts and OpenCode keep the public-key flow.
Personal keys still belong to the built-in OpenCode Zen provider.

Whatever is typed in the key field, the plugin signs in with the one
shared `public` credential: a key made under your own OpenCode account
does nothing here, and several of them don't make several accounts. Your
own Zen keys go in magpie's built-in OpenCode Zen provider (or OpenCode's
`opencode` provider), which takes several keys.
The credential is kept in OpenCode's `auth.json` or magpie's
`plugin-auth.json`.

## Models

The plugin discovers Zen's current free models, including their context
windows and reasoning levels. Use `opencode-zen-free/<model>`, for example
`opencode-zen-free/big-pickle`.

Retired models and SystemOne models are excluded. The list is asked
again each time the host lists models (magpie does this on start and every
hour): a model Zen no longer gives free leaves it, and a new free one joins
it. A model Zen lists as `-free` that OpenCode's catalog and docs don't
describe yet (or can't be read) is offered too, on Chat Completions, as
OpenCode asks a model with no package of its own. When Zen's list can't be
read, the last list is kept. A request for a
model that isn't free now gets a 404 naming the free ones; one made free
since the last list is served after the list is asked again (at most once a
minute). Availability and rate limits are set by Zen; the plugin has no
remaining-quota data.

## Requests

Requests go to `https://opencode.ai/inference/v1` using each model's native
Chat Completions, Responses or Anthropic Messages API. Streaming and
ordinary JSON replies are supported.

The agent's tools are preserved. Zen's models often call OpenCode's own
tool names; such a call is given the agent's tool whose name differs only
in case (`bash` to `Bash`), or else only in case and `_`/`-` (`todowrite`
to `todo_write`, `webfetch` to `web_fetch`), when exactly one does. A
call of a tool the agent has no spelling of (`psh` beside `pwsh`, `bedit`)
reaches the agent as the model called it, as with any other provider: the
agent answers it with its own unknown-tool error, and the model corrects
the name and goes on. Only a call with no name is left out, and the
reply's text says so; a turn whose every call was left out ends as an
ordinary answer. Tools run in the agent.

Zen's free tier only answers a request that carries tools, so a request
is sent with the five core OpenCode tools the agent doesn't declare
itself (`bash`, `edit`, `glob`, `grep`, `read`), described as not
available. A call of one of them the agent doesn't have reaches the agent
like any other.

Zen's free tier also tells OpenCode's own requests by the environment
block every OpenCode prompt ends with (`<env>`, a `Working directory:`
line, `</env>`) in a system message. Another agent's request without one
gets a small allowance a day and then `429 FreeUsageLimitError` ("Free
models work in OpenCode") until 00:00 UTC, while OpenCode's go through.
So a request whose system messages have no such block gets one added
after the agent's own prompt (Anthropic `system` and Responses
`instructions` likewise), its working directory said as unknown; a
prompt that has one, as OpenCode's does, goes as it is.

Now and then Zen closes a streamed Chat Completions reply before its
`[DONE]`. When the reply has said something and no tool call of it is
unfinished, it ends there as an ordinary answer, and its text says it was
cut short; asking again goes on. A reply cut short with a tool call
unfinished, with nothing said, or collapsed for a client that doesn't
stream fails with an error naming the reply's id and how much of it came.
An Anthropic Messages or Responses reply cut short fails too: magpie
tells it from a whole one and, where the model can, goes on with it.
