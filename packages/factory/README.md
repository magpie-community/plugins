# @magpie-community/opencode-factory-auth

Signs in to a [Factory](https://factory.ai) (Droid) subscription and sends
model requests to Factory's API the way `droid` sends them. Provider id:
`factory`.

## Sign-in

- **Sign in with Factory (device code).** This is WorkOS's device flow
  under droid's own client. The browser opens Factory's page with the code
  filled in. Confirm it there, and the plugin picks up the tokens.
- **Factory API key.** A key (`fk-…`), as droid takes one from
  `FACTORY_API_KEY`. It is sent as the bearer token with droid's headers
  and never renewed. A key carries no organization header; `whoami`, asked
  once with the key, says whose it is and where its organization is served.
- **Organization.** A token that isn't in an organization yet is put in
  the first one your account belongs to.
- **Whoami.** The plugin asks `whoami` for your active organization, its
  region (EU orgs go to `api.eu.factory.ai`) and any host of the org's
  own. Every request then carries them, as droid's do.

## Where the sign-in is kept

The sign-in is kept wherever the host keeps provider sign-ins:

- OpenCode: `~/.local/share/opencode/auth.json`
- magpie: `plugin-auth.json`

It holds WorkOS's access and refresh tokens, with the organization,
region and host.

**Refreshing.** The access token is renewed two minutes before it lapses.
WorkOS rotates the refresh token, so the plugin never runs two refreshes
at once.

**Refusals.** If Factory refuses the organization a request names, the
plugin asks `whoami` again and resends the request once. If the refusal
stands, the error says what to check.

## Requests from other agents

Factory serves a subscription's model requests to Droid. Every request
droid sends opens its system prompt with "You are Droid, an AI software
engineering agent built by Factory.", so another agent's request to
Factory's OpenAI-shaped API (`/api/llm/o`: GPT and Grok on Responses, the
open models on chat completions) opens with that line too, the agent's own
prompt after it. On Anthropic's Messages (`/api/llm/a`), the plugin adapts
fixed client metadata while preserving the task instructions and history;
see [Claude Code through magpie](#claude-code-through-magpie) below.

## Models

Each model is served on the one API droid uses for it:

| API | Models |
|---|---|
| Anthropic Messages (`/api/llm/a`) | Fable 5.1, Fable 5, Opus 5.5, Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5, Sonnet 4.6, Haiku 4.5, MiniMax M2.7 |
| OpenAI Responses (`/api/llm/o/v1`) | GPT-6 Sol/Astra/Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, GPT-5.3-Codex, Grok 4.7, Grok 4.6 |
| Chat completions (`/api/llm/o/v1`) | GLM-5.3, GLM-5.3-Flash, GLM-5.2, Kimi K3, DeepSeek V4.1 Flash, Qwen3.8 Max, MiniMax M3, Mistral Medium 3.5, Nemotron 3 Ultra |

Reasoning efforts are the variants droid offers for each model.

The list is not included:

- Gemini, which Factory sends on a route of its own.
- auto, which droid picks on the client side.

## Use

```sh
magpie plugin add @magpie-community/opencode-factory-auth
magpie plugin login factory
```

## Claude Code through magpie

Factory's Anthropic route requires Droid's fixed client preamble and
refuses some of Claude Code's fixed environment and model wrappers. The
plugin adapts that metadata while preserving the coding instructions,
environment values, tool definitions, tool results, images and reasoning
options. Native Droid requests remain unchanged, and OpenAI routes keep
their existing request adapter.

Use magpie's Claude Code integration to select the Factory provider.
magpie manages the provider-specific client settings, including capability
and permission configuration. Fields such as `safeguards` and
`context_management` are forwarded for Factory to validate; the request
adapter preserves them along with the other request options.

The same metadata adaptation applies to `/messages` and
`/messages/count_tokens`, so token counting sees the prompt used for
inference. Serving the counting endpoint still depends on the host and
upstream. Model and feature availability depend on the Factory account,
organization region and upstream API. Connectivity has been verified with
Sonnet 4.6, Sonnet 5.5 and Opus 5.5, and a two-turn Read tool call with
Sonnet 4.6.
