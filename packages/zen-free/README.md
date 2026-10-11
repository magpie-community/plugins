# OpenCode Zen Free

OpenCode Zen's free models in magpie and OpenCode. Provider id:
`opencode-zen-free`.

## Install

```sh
magpie plugin add @magpie-community/opencode-zen-free-auth
magpie plugin login opencode-zen-free
```

## Sign in

Enter `public` in the key field. No personal API key is needed.
The credential is kept in OpenCode's `auth.json` or magpie's
`plugin-auth.json`.

## Models

The plugin discovers Zen's current free models, including their context
windows and reasoning levels. Use `opencode-zen-free/<model>`, for example
`opencode-zen-free/big-pickle`.

Retired models and SystemOne models are excluded. The list is asked
again each time the host lists models (magpie does this on start and every
hour): a model Zen no longer gives free leaves it, and a new free one joins
it. When Zen's list can't be read, the last list is kept. A request for a
model that isn't free now gets a 404 naming the free ones; one made free
since the last list is served after the list is asked again (at most once a
minute). Availability and rate limits are set by Zen; the plugin has no
remaining-quota data.

## Requests

Requests go to `https://opencode.ai/zen/v1` using each model's native
Chat Completions, Responses or Anthropic Messages API. Streaming and
ordinary JSON replies are supported.

The agent's tools are preserved. Zen's models often call OpenCode's own
tool names; such a call is given the agent's tool whose name differs only
in case (`bash` to `Bash`), or else only in case and `_`/`-` (`todowrite`
to `todo_write`, `webfetch` to `web_fetch`), when exactly one does. A
call with no such tool (or with no name) is left out of the reply, and
the reply's text says which name was left out; a turn whose every call
was left out ends as an ordinary answer. Tools run in the agent.
