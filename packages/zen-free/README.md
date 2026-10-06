# @magpie-community/opencode-zen-free

OpenCode Zen's free models in magpie and OpenCode. Provider id:
`opencode-zen-free`.

## Install

```sh
magpie plugin add @magpie-community/opencode-zen-free
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

The agent's tools are preserved. If Zen calls an added tool, its name is
mapped to the agent's unique case-insensitive match (`bash` to `Bash`).
A call with no matching tool returns an error. Tools run in the agent.
