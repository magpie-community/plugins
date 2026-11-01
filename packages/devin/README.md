# @magpie-community/opencode-devin-auth

Signs in to a [Devin](https://devin.ai) subscription, the account the
`devin` CLI uses, and makes its requests, in OpenCode and in magpie.
Provider id: `devin`.

## Signing in

An account is the CLI's session token (`devin-session-token$…`). There are
two ways to get one:

- **Devin (browser)**: the CLI's own `devin auth login`, run by the
  plugin. It is a PKCE sign-in through `app.devin.ai/auth/cli/continue`
  back to a callback on `127.0.0.1`. The code is exchanged for the token
  at `server.codeium.com` (`ExchangeDevinCLIPKCECode`).
- **Devin CLI's sign-in**: takes the account the CLI is signed in to, from
  its `credentials.toml` (`$XDG_DATA_HOME/devin/`, by default
  `~/.local/share/devin/`; `%APPDATA%\devin\` on Windows). The file is only
  read, never changed.

The plugin names the account as Devin does when asked with the token
(`GetUserStatus`: its email, organization when named, and tier). When Devin can't tell, and the CLI
is installed, it asks `devin auth status`, run with a data folder of the
plugin's own, `~/.cache/opencode-devin-auth/<hash of the token>/`, so the
CLI's own sign-in is never touched. A CLI that reads another
`credentials.toml` than that folder's (on Windows it reads
`%APPDATA%\devin\` whatever it is run with) isn't asked: it would name
its own account. Otherwise the account is named "Devin".

The token is kept where OpenCode keeps sign-ins (`auth.json`; in magpie,
`plugin-auth.json`) as `{ "type": "api", "key", "metadata": { "email", "plan", "orgId", "teamId" } }`.
Devin doesn't expire it on a schedule, so there is nothing to refresh;
when it is refused, requests fail with a 401 saying to sign in again,
and the usage read marks the account signed out (`signIn: "expired"`), so
magpie passes over it and offers Sign in again on its row. A clean read
takes the mark off.

## Requests

Devin serves chat through Windsurf's API server, as the CLI does:
`POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`,
a Connect RPC in protobuf, with `Authorization: Basic <token>`.
`WINDSURF_API_SERVER_URL` moves the server, as it does for the CLI.

The plugin's `fetch` handles this:

- It turns OpenCode's chat completion into the CLI's request (devin-cli
  3000.11.3).
  - The system prompt goes at the head of the first user message.
  - Each tool's description goes there too, in a `<tool_descriptions>`
    block, and the tool is sent with a pointer to it. Devin answers "an
    internal error occurred" to some agents' tool descriptions when they
    are sent as the tools' own.
  - A tool call the conversation never answered is answered with "Tool use
    was interrupted and did not produce a result."
  - Images must be inline (`data:` URLs). The images a tool returned go
    with its result, as magpie's built-in sends them: a tool message's own
    `image_url` parts, and the ones magpie's gateway puts in the user
    message after the results ("[From the result of …]").
- The Claude models are asked on Anthropic's Messages API
  (`@ai-sdk/anthropic`, `POST …/devin/v1/messages`); every other model
  stays on chat completions (since 0.1.28, #566). A failed tool result
  says so in its text, "Error: " first (0.1.29).
  - Each text block, system block, tool call turn and tool result is a
    `ChatMessagePrompt` of its own, in the order the client sent them, and
    one the client marked with `cache_control` carries
    `prompt_cache_options {type: EPHEMERAL}` (field 8), as the devin CLI
    marks its own. Blocks joined into one message lose the mark: a grown
    history then read only ~558 tokens from the cache.
  - Mid-conversation `role: "system"` notices stay in the history as user
    prompts, with their block boundaries and cache marks. A notice that
    arrives before pending tool results follows those results, as Devin
    requires; it does not replace them or join the stable system prefix.
  - Claude Code's `x-anthropic-billing-header` line isn't sent: its
    `cch` changes every turn.
  - The reply comes back as Anthropic's message or events, with the
    cache's read and write in `usage`. `/messages/count_tokens` is a 404.
- A request past 8 KiB goes gzipped, as the CLI sends it (since 0.1.21,
  #275): Devin turns a body past 10 MiB away with 413.
- It turns the streamed reply back into a chat completion, streamed or
  not: text, reasoning, tool calls and usage.
- Failures keep their statuses: a refused token is a 401, a usage limit a
  429, a prompt too long for the model a 400.
- A reply with only metadata and usage is a 502, even when output tokens
  were counted. The plugin waits for actual content before opening a
  successful stream, so the gateway can try another channel.

## Keeping the cache warm

Devin keeps a prompt cache for 5 minutes, and has no longer TTL to ask
for (`PromptCacheOptions` has only `type: EPHEMERAL`; Claude Code's
`ttl: "1h"` has nowhere to go). After 5 minutes without a request, the
next turn writes the whole context again.

**Keep the cache warm** (`cache_keepalive`), a switch in the provider's
editor in magpie, **off by default** (#592), keeps it as the devin CLI
does (`cache_keepalive.rs`, 3000.11.205): after a reply that read or wrote
the cache, whatever it stopped for (a tool call waiting too), the same
`GetChatMessage` is sent again every 285 seconds, byte for byte, with one
more user prompt, `continue`, and `max_tokens` 1. Each one reads the cache
and renews it. Unlike the CLI's, it also runs while the user is reading
the reply, not only while a tool or subagent works.

- The conversation's next real request stops its pings; its own reply
  starts them again. A conversation is the session the agent names, the
  Claude Code subagent (`x-claude-code-agent-id`) and a hash of the
  instructions, the tools' names and the first user message, so a
  subagent's requests never stop its lead's pings.
- They stop on a 401, 402 or 429, after two pings in a row that read less
  than half their prompt from the cache, at the most pings (6), when the
  switch goes off, and with the plugin host's process. The timers never
  keep a process running.
- The plugin's options change the interval and the most pings:
  `cacheKeepaliveInterval` (seconds, 30–299, default 285) and
  `cacheKeepaliveMaxPings` (1–50, default 6). In magpie they are set from
  the plugin's row on the Plugins page (Installed › Options, which starts
  from these defaults), or in its `plugins.json` entry; in OpenCode,
  `["@magpie-community/opencode-devin-auth", {…}]`. In OpenCode, which
  has no switch, `cacheKeepalive: true` turns it on.
- Each ping shows in magpie's request log and usage totals as a call of
  magpie's, *Cache keep-alive*, on the conversation's model and account,
  with its tokens and cost (a magpie that has `magpie.usage`, from
  11-01; #592). The pings go straight to Devin, never through magpie's
  gateway, which would re-shape the request so the cache no longer
  matched. One cut short by the conversation's next request isn't
  listed. An older magpie, and OpenCode, list none.

**The cost.** Each ping is billed as a cache read of the whole context, plus
a token or two. That is about a tenth of writing it again, but it is
spent whether or not the conversation goes on: six pings of a 300k-token
context read 1.8M cached tokens over 28 minutes, and if the user never
comes back, all of it is lost. It pays when the next turn comes after 5
minutes and within half an hour; a user who leaves a conversation for good
pays for nothing. So it is off until turned on.

## Models

Devin's models are families: `swe-2`, `claude-opus-5-5`, `gpt-6-sol`, …
Each family has variants at each effort (`swe-2-high`,
`claude-opus-5-5-xhigh`), and some have a fast or priority run
(`claude-opus-5-5-high-fast`). The plugin lists each family once, with
the efforts its variants are at, plus its fast or priority run
(`claude-opus-5-5-fast`). The variant asked for is the one at the effort
picked, or the nearest the family has; with none picked, the family's
default. Variants at no effort (`glm-5-2-1m`) are listed as they are.
Adaptive and Fusion aren't listed; they route between models inside
Devin's own agent.

The `config` hook declares Devin's list as of 2026-10-14 (89 models).
Once signed in, the `provider.models` hook replaces it with the account's
own: what Devin tells the CLI's model picker for the account's token
(`GetCliModelConfigs`, the list `devin models list` prints), with or
without the CLI and on every system. When Devin can't be asked, the list
is the CLI's `devin models list`, if the CLI names the account Devin names
the token's (on Windows it reads its own sign-in whatever folder it is
given, so it answers only for that account); else the declared list. The
list is cached for 5 minutes; after a failed read, the plugin tries again
after 1 minute.

Which models take images is what Devin tells its CLI's model picker
(`GetCliModelConfigs`, each model's `supports_images`), asked once signed
in, with or without the CLI, and cached as the list is: `swe-2`, `swe-1.7`
and most others do; GLM-5.2, GLM-5.3, Inkling, Nemotron, DeepSeek V4 Flash
and V4 Pro don't. Before Devin is asked, or when it can't be, the declared
list says what Devin said on 2026-10-05. A model Devin says nothing of
takes models.dev's word.

## Not included

magpie's built-in Devin account does more than this plugin:

- **Usage**: the plan's quota windows.
- **Several accounts** at once.
- **Web search**: its stand-in for Anthropic's server-side web search tool.
