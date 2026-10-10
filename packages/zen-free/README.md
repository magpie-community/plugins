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

Retired models and SystemOne models are excluded. Availability and rate
limits are set by Zen; the plugin has no remaining-quota data.

## Requests

Requests go to `https://opencode.ai/zen/v1` using each model's native
Chat Completions, Responses or Anthropic Messages API. Streaming and
ordinary JSON replies are supported.

The agent's tools are preserved. Zen's models often call OpenCode's own
tool names; such a call is given the agent's tool whose name differs only
in case (`bash` to `Bash`), or else only in case and `_`/`-` (`todowrite`
to `todo_write`, `webfetch` to `web_fetch`), when exactly one does. A
call with no such tool returns an error that names it. Tools run in the
agent.
