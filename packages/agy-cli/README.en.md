# agy-cli

Turn the local Antigravity CLI (`agy`) into a model provider inside Magpie. Once
it is set up, clients such as OpenCode and Claude Code can reach the Gemini,
Claude and GPT-OSS models in your subscription through Magpie, and every request
is actually carried out by an `agy` process.

**[中文 → README.md](README.md)** · Provenance, licensing and migration notes:
[NOTICE.md](NOTICE.md)

## What it is

The plugin runs as a Magpie provider. A client sends an Anthropic Messages
request; the plugin turns it into Agent Client Protocol (ACP) messages, hands
them to a local `agy acp` process, and converts the output back into a streamed
response.

- The work is done by the real agy CLI over the ACP channel it ships with. The
  plugin does not impersonate the IDE and does not call Google's internal
  endpoints directly.
- Tools that belong to the client, such as file reads, writes and shell commands,
  are exposed to the model over MCP. The client runs them and the results flow
  back into the same agy conversation, so the model sees ordinary native tool
  calls.
- Account standing is outside the plugin's control. If Google changes its usage
  policies, the plugin cannot promise your account will not be restricted.

## Features

- **Every model in the subscription**: switch between Gemini, Claude and GPT-OSS
  models mid-conversation without losing history. Thinking levels can be changed
  the same way.
- **Streaming with thought summaries**: summaries come back as `thinking` blocks.
  Set `AGY_BRIDGE_THINKING=0` to turn them off.
- **Image input**: inline base64 PNG, JPEG, GIF and WebP. This needs agy 1.5.0 or
  newer, because the ACP server has to advertise image support.
- **Tool calls**: parallel and consecutive calls both work. A tool that runs past
  150 seconds first gets a "still running" placeholder; once the real result
  arrives, the same turn continues, and the client executes each call exactly once.
- **Session resume**: each finished turn is recorded. After a Magpie or plugin
  restart, the session continues through `session/resume` as long as the history
  and instruction hashes still match. The state file stores session IDs and
  hashes, never message text.
- **Isolation**: your global MCP configuration is never read. Every agy process
  runs with a temporary agent, and every permission request agy raises (shell,
  file edits, browser) is refused. Real actions happen on the client side.
- **Usage visibility**: Magpie shows the agy subscription usage windows. They are
  informational only; running out of quota does not block requests automatically.

## Requirements

- The Antigravity CLI (`agy`) with the `acp` subcommand, signed in to a Google
  account at least once from an interactive terminal. Text and tool calls have
  been verified on 1.4.12 and 1.5.0; image input needs 1.5.0.
- A Magpie build with OpenCode-style provider plugin support. Usage reporting was
  verified on Magpie 0.1.1599.
- agy versions older than 1.1.11 are refused for usage queries, because those
  builds can treat `/usage` as an ordinary model prompt.

## Install

From the Magpie community plugins: find "Antigravity (local agy CLI)" on
Magpie's Plugins page and install it, or run:

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

The provider id is `agy-cli`, so models are named `agy-cli/<model>`. The
default concurrency is 16; change it under Concurrency on Magpie's Providers
page (0 means no limit).

After installing, run `agy` once in a terminal to complete the Google sign-in.

## Usage

1. Open Magpie's Providers page, find `agy-cli`, and click Sign in. The
   plugin uses `agy models` to confirm the CLI works. Google credentials stay with
   agy; the plugin never reads or stores them.
2. Refer to models as `agy-cli/<model>`. When agy lists separate model IDs
   for different thinking levels, they are grouped here as variants of one model,
   and each request is mapped back to the matching agy ID.
3. Pick the model in your client as usual.

## Concurrency

- The plugin's own pool is capped by `AGY_BRIDGE_MAX_PROCS`, which defaults to 16
  agy processes.
- Magpie's Providers page has its own Concurrency field that accepts 0 to 1000,
  where 0 means no limit. A value set there overrides the default of 16 that the
  plugin declares in `magpie.maxConcurrency`.
- When the pool is full and no process can be evicted, the plugin answers with
  HTTP 503. Keep the two numbers aligned: if the Providers page allows more
  concurrent requests than the pool holds, the extra ones will get 503.

## Platforms

- **macOS and Linux**: supported.
- **Native Windows**: supported for `.exe`, `.cmd` and `.bat` lookup and launch,
  silent background update checks, and `magpie quota`. So far only the command
  construction has unit tests; end-to-end runs on real Windows hardware are still
  pending.

## Usage quota

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

The numbers come from agy's own `/usage` report for whichever account is signed
in to the CLI, broken down by model group. The plugin does not read or write
Google tokens and does not present itself as another account. A window with no
measurable data shows "Limits not available" rather than a fake 0% or 100%.

## Environment variables

| Name | Default value | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum number of agy processes in the pool |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to stop forwarding thought summaries |
| `AGY_BRIDGE_EFFORT` | unset | Force a thinking level: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | on | Set to `0` to keep agy's default prompt components (about 2,600 more input tokens per model call) |
| `AGY_BRIDGE_IDLE_MS` | 600000 | How long a process may sit idle before it is reclaimed; the session can still resume |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | How long a reclaimed session stays resumable (6 hours) |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | Where resumable session records are kept |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | After this long, a still-running client tool gets a "still running" reply |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | Limits for process startup, agy silence, and waiting on a client tool result |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | How long a suspended tool turn whose client disconnected may keep its pool slot |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for the replayed history prompt |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | Total time budget for a usage query, capped at 18000 |
| `AGY_BRIDGE_MCP_TRACE` | unset | Writes MCP channel traffic to the given file; for debugging only |

## Troubleshooting

- **agy cannot be found**: set `AGY_PATH` to the executable, or make sure `agy`
  is on PATH.
- **Sign in fails, or agy reports a login problem**: run `agy` in a terminal and
  finish the Google sign-in again.
- **HTTP 503**: the pool is full. Raise `AGY_BRIDGE_MAX_PROCS` and the Providers
  page Concurrency, or reduce the number of simultaneous sessions.
- **Usage shows "Limits not available" or a version error**: that window has no
  measurable data. For a version error, upgrade agy to 1.1.11 or later.
- **Image requests return HTTP 400**: the running agy does not advertise image
  support (1.5.0 or later is needed). Only inline base64 is accepted; image URLs
  and binary documents such as PDFs are rejected.
- **A reply contains "Agent execution terminated due to error."**: that is agy's
  in-band error marker. The plugin reads the real cause from agy's log and ends
  the turn with an error instead of passing the marker through as text.
- **HTTP 409 saying tool results do not match the history**: usually the client
  rewrote the history or tool IDs mid-conversation. When the plugin can work out
  the correct match it rebuilds the session; when it cannot, it refuses rather
  than guessing.
- **Turning thought summaries off**: set `AGY_BRIDGE_THINKING=0`, or send
  `thinking: { "type": "disabled" }` with the request.

## Development

```sh
node --check index.mjs
node --check mcp-server.mjs
node --check usage.mjs
npm test
npm pack --dry-run
```

`npm test` runs the full ACP and MCP path against a fake agy process, so it uses
no quota. The integration check against the real CLI is opt-in and uses a small
amount of subscription quota:

```sh
AGY_BRIDGE_INTEGRATION=1 npm run test:integration
```

## License

MIT. Copyright notices live in [LICENSE](LICENSE); upstream provenance and the
list of changes are in [NOTICE.md](NOTICE.md).
