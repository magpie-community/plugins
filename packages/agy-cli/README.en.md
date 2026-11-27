# agy-cli

Turn the local Antigravity CLI (`agy`) into a model provider inside Magpie. Once
it is set up, clients such as OpenCode and Claude Code can reach the models agy
offers this plugin through Magpie, and every request is actually carried out by
an `agy` process.

**[中文 → README.md](README.md)** · Provenance, licensing and migration notes:
[NOTICE.md](NOTICE.md)

## What it is

The plugin runs as a Magpie provider. A client sends an Anthropic Messages
request; the plugin turns it into Agent Client Protocol (ACP) messages, hands
them to a local `agy acp` process, and converts the output back into a streamed
response.

- The work is done by the real agy CLI over the ACP channel it ships with. The
  ACP handshake's `clientInfo` is the plugin's own package name and version
  (`opencode-agy-cli-auth`), not Zed or any other editor. The plugin calls
  none of Google's endpoints itself: the quota too is read through agy alone
  (`agy -p /usage`, see "Usage quota"), never with agy's stored token.
- Tools that belong to the client, such as file reads, writes and shell commands,
  are exposed to the model over MCP. The client runs them and the results flow
  back into the same agy conversation, so the model sees ordinary native tool
  calls.
- Account standing is outside the plugin's control. If Google changes its usage
  policies, the plugin cannot promise your account will not be restricted.

## How it differs from Antigravity ACP

The community Antigravity ACP plugin (`antigravity-acp`) serves the same
channel: Antigravity's models over ACP. The differences:

- **What runs**: Antigravity ACP downloads Google's ACP server
  (`agy_acp_server.par`, about 400 MB) and rides the Antigravity IDE's sign-in.
  This plugin runs the `agy` CLI (`agy acp`): your own when you have one, and
  when the machine has none, signing in from Magpie installs one the way
  Google's own installer does (see "Requirements").
- **Sessions**: Antigravity ACP opens a new session per request and carries the
  history as context. This plugin keeps a pool of agy processes, reuses one agy
  session for one conversation, and picks it up again with `session/resume`
  after a restart; only when that fails does it replay the history. agy cuts
  one prompt at 128 KiB, so with agy 1.5.17 or later a longer replay (or a
  long paste) goes in over as many prompts as it takes, each but the last
  cancelled before the model answers it, up to the model's window
  (`AGY_BRIDGE_MAX_REPLAY_BYTES`); the model is told when older history had
  to be left out. When magpie's image-slim swaps an earlier image for its
  placeholder (on Codex, a whole view_image output for one line of text), or
  magpie leaves one out to fit a size or image limit, the session holds.
  So does a Claude Code conversation whose Bash `cd` moved its working
  folder, or whose ToolSearch loaded a tool in the middle of a turn: the
  turn goes on in the same session with the new tool listed. A subagent
  (Task) and Claude Code's own side requests (titles, summaries) are
  conversations of their own and get sessions of their own. Each new
  session writes an `agy_bridge_session` row with `"action":"session_new"`
  and its `reason` to the plugin host's log; `park_miss` says why a
  session kept from before a restart was not taken (`none`, `expired`,
  `work_dir`, `instructions`, `history`, ...), and `resume_failed` why
  agy's `session/resume` failed.
- **Tool calls**: Antigravity ACP ends the turn with the call as the reply's
  `tool_calls`. This plugin feeds the client's result back into the same agy
  turn (see "Tool bridge" below).
- **Usage**: this plugin reads agy's own `/usage` report; Antigravity ACP reads
  the quota each reply carries.

## Tool bridge

agy reaches `--ide-mcp-port` by running `nc 127.0.0.1 <port>`. The plugin puts
a private `nc` first on agy's PATH, which connects that line to the plugin's own
MCP server. The control port listens on loopback only, with a token per process.

- This rests on how agy dials, not on an interface agy promises. It was checked
  on 1.4.12 and 1.5.0. On an agy older than 1.4.12 the plugin refuses the session
  and says to update.
- The private `nc` applies only to the agy processes the plugin starts, but for
  those it stands in for every `nc` agy runs.
- Every client tool is listed with `_meta: {"antigravity/alwaysLoad": true}`.
  Without it agy loads larger tools on demand, out of the model's function
  list, and the model cannot reach them (#989).

## Features

- **The models agy offers**: the list follows the model option agy advertises
  in the ACP session. A model `agy models` lists but the session does not offer
  this client (agy may keep Claude and GPT-OSS for clients it recognises) is
  left out. To list models, the plugin opens one session with `agy acp` (no
  prompt is sent) and reads what it offers; until it has, only Gemini is listed.
  The last list agy gave and offered is kept in `models.json` beside the session
  state file, so after a restart that list is served while agy is asked again:
  both what it lists and what a session offers, and again whenever the list
  changes (another account or plan).
  Models and thinking levels can be switched mid-conversation without losing
  history.
  `agy models` runs with `--settings '{"modelProvider":""}'`, so a
  `"modelProvider": "gemini"` (AI Studio key) in settings.json doesn't change
  this list: it lists the Google account's models. An AI Studio key is added on
  magpie's Providers page as Google Gemini.
- **Streaming with thought summaries**: summaries come back as `thinking` blocks.
  Set `AGY_BRIDGE_THINKING=0` to turn them off.
- **Image input**: inline base64 PNG, JPEG, GIF and WebP. This needs agy 1.5.0 or
  newer, because the ACP server has to advertise image support. An image a tool
  returns (a screenshot from `read`) goes to agy as a prompt image too: over MCP,
  agy would save it to a file the model can't open.
- **Tool calls**: parallel and consecutive calls both work. A tool that runs past
  150 seconds first gets a "still running" placeholder; once the real result
  arrives, the same turn continues, and the client executes each call exactly once.
- **Session resume**: each finished turn is recorded, and so is each step of a
  tool loop in progress. After a Magpie or plugin restart, the session continues
  through `session/resume` as long as the history and instruction hashes still
  match; a restart in the middle of a tool loop sends only the step's tool
  results, never the conversation again. Switching models (Claude Code's
  `/model`, which also rewrites the model line in its system prompt) keeps the
  session: agy changes the model in place, and only the new model's first turn
  reads the context without a cache. agy's prompt cache follows the folder it
  runs in, so a resumed session runs in its own temporary folder again and its
  cache still hits. The state file stores session IDs, hashes and that folder,
  never message text.
- **Isolation**: your global MCP configuration is never read. Every agy process
  runs with a temporary agent, and every permission request agy raises for its
  own tools (shell, file edits, browser) is refused. A request for one of the
  client's tools on the bridge's `ide-tools` server is allowed once, since that
  tool runs in the client under the client's own permissions. Real actions
  happen on the client side. Set `AGY_BRIDGE_ALLOW_AGY_TOOLS=1` to instead start
  agy with `--dangerously-skip-permissions` and let its own tools through.
- **Assistant prefill**: requests that end with a text-only assistant message
  (SillyTavern presets, "continue"/"impersonate", bot frameworks) are served
  instead of rejected; the session ledger stays aligned across turns. See
  "Assistant prefill" below.
- **Usage visibility**: Magpie shows the agy subscription usage windows. Each
  model's window (its pool's most used one) is what Magpie's routing weighs the
  account by for that model, so a routing group puts it by what it has left,
  and a model whose pool is used up is passed over for the next member. agy's
  `/usage` report names no plan, so none is shown.

## Assistant prefill

A client request that ends with a **text-only assistant message** (a
SillyTavern preset prefill, a "continue" / "impersonate" turn, a bot
framework's assembled context) used to be rejected with a 400. The prefill now
becomes part of the current turn:

- The prefill stays in the tail, so the session ledger (expectedMessages,
  client bytes) stays aligned with the client's own history across turns — the
  session is reused after a prefill turn instead of replaying from scratch;
- The prefill text renders as a continuation carrier (a note line plus the
  fragment itself), telling the model to continue from where the fragment
  stops;
- `AGY_BRIDGE_PREFILL=0` restores the stock 400 reject;
  `AGY_BRIDGE_PREFILL_CARRIER_NOTE` overrides the carrier's note line.

Known limits: a prefill alongside a live tool_result, or directly after an
unanswered tool_use, is still rejected; a
contiguous assistant tail with no user message before it is treated as one
prefill run (that turn degrades to a fresh session and self-heals on the next
turn); the models a client gets remain agy's decision.

## Requirements

- The Antigravity CLI (`agy`) with the `acp` subcommand. On a machine without
  agy (Magpie's Docker container, say), Sign in in Magpie 0.1.4246 or later
  installs it first: downloaded from where Google's install script gets it,
  checked against its sha512, and kept in the data folder
  (`$XDG_DATA_HOME/magpie-agy-cli/agy`, else `~/.local/share/magpie-agy-cli/agy`;
  `%LOCALAPPDATA%\magpie-agy-cli\agy.exe` on Windows). In the container that
  folder is on the /config volume, so it survives a restart. An agy you
  installed yourself comes first. Signing in from Magpie
  needs agy 1.5.0 or later (`agy acp --login`); with an older one, run `agy` in
  a terminal once to sign in. Text and tool calls have been verified on 1.4.12
  and 1.5.0; image input needs 1.5.0.
- A Magpie build with OpenCode-style provider plugin support. Usage reporting was
  verified on Magpie 0.1.1599.
- agy older than 1.4.12 is refused for sessions (see "Tool bridge"), and older
  than 1.1.11 for usage queries too, because those builds can treat `/usage` as
  an ordinary model prompt.
- **Auto-update**: the agy processes the plugin starts get
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` by default, so the processes in the pool
  don't update one binary under each other. agy runs you start yourself are not
  affected and update as usual. If you set `AGY_CLI_DISABLE_AUTO_UPDATE`
  yourself (`false` included), the plugin passes your value on as written. If
  you use agy only through this plugin, run `agy` in a terminal now and then so
  it updates: an old version stands out too. The copy the plugin installed is
  kept current by the plugin: checked a minute after it starts and every 6
  hours after, and a new version is downloaded, checked and tried before it
  replaces the old one. Not when you set `AGY_CLI_DISABLE_AUTO_UPDATE`.

## Install

From the Magpie community plugins: find "Antigravity (local agy CLI)" on
Magpie's Plugins page and install it, or run:

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

The provider id is `agy-cli`, so models are named `agy-cli/<model>`. The
default concurrency is 16; change it under Concurrency on Magpie's Providers
page (0 means no limit).

After installing, sign in from Magpie; no terminal needed.

## Usage

1. Open Magpie's Providers page, find `agy-cli`, and click Sign in. If agy is
   signed in already, that's all. If not, the plugin runs agy's own Google
   sign-in (`agy acp --login`): Magpie opens the sign-in page, and you paste the
   code the page shows (or the page's whole address) back into Magpie. This
   works with Magpie on a server or in Docker too. The sign-in waits 15
   minutes. Google credentials stay with agy (in the system keyring); the
   plugin never stores them, and counts the sign-in as done only once
   `agy models` lists the account's models. Magpie names the account by the
   Google email agy stored (the one thing read from the keyring for it).
   To add another Google account, click agy-cli's Add another account (or
   Sign in) and pick "Add another Google account". The new account gets an
   agy home of its own (under `~/.local/state/magpie-agy-bridge/accounts/`),
   and agy keeps its sign-in in a file there, leaving the account in the
   system keyring as it is. Each account has its own row and its own usage,
   and is switched and rotated like any provider's accounts.
   agy itself holds one Google account. So that the account agy holds now
   keeps working after agy is signed in to another (in a terminal, say), the
   plugin keeps a copy of its sign-in, as agy stored it, in a home of its own
   there (`own…`, the file readable by you only). While agy holds another
   account, that account's usage, models and requests run agy with this
   copy. The keyring is only read, never written. An account agy stopped
   holding before 0.1.113 has no copy: sign it in again once.
   agy's sign-in may not say which Google account it is (no
   `id_token_email`, as a sign-in in a terminal can leave it). Each account
   of agy's own then runs with its own copy; with two or more of them, one
   with no copy is refused with why instead of running as whoever agy holds:
   sign it in again with "Add another Google account". A second account of
   agy's own signed in with "Sign in with Google" gets a home of its own,
   with a copy of agy's sign-in, so two accounts never share agy's one
   sign-in (#1599).
   Accounts signed in on the retired Antigravity plugin (`antigravity`) move
   over from the line Magpie shows over its Providers list (Move), or from
   agy-cli's Import accounts from a file…, which takes that plugin's sign-in or
   agy's own token file. They are Antigravity's own Google sign-ins: each gets
   an agy home of its own and is added once agy signs in with it, and the
   credential goes nowhere else.
2. Refer to models as `agy-cli/<model>`. When agy lists separate model IDs
   for different thinking levels, they are grouped here as variants of one model,
   and each request is mapped back to the matching agy ID.
3. Pick the model in your client as usual.

## Image generation and editing

`agy-cli/gemini-3.1-flash-image` is an image-only model, offered in Magpie's
Settings → Images → Image generation. It answers OpenAI-compatible
`/images/generations` and `/images/edits` (`multipart/form-data` or JSON data
URLs, up to 3 reference images, no mask); `n` above 1 runs in parallel. Each
request runs an isolated `agy acp` session that may only read files in its own
working folder, call the `image-generator` subagent and `generate_image`;
every other tool is refused. The folder and the session's files are removed
afterwards. Pixel sizes and ratios are mapped to the aspect ratios agy takes.

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
in to the CLI, broken down by model group. Each group's models share its
5-hour and weekly limits, so magpie shows the groups, and under "Every model"
each model the group names, reading the group's most used limit (the one that
stops it; Google's own per-model figure was the group's). The plugin never writes Google tokens; it always reports the account agy is signed in to. A window with no
measurable data shows "Limits not available" rather than a fake 0% or 100%.

The quota is read through agy alone: the plugin runs `agy -p /usage`, so every
request Google sees is agy's own. The plugin never reads agy's stored token to
call Google's quota endpoints itself, nor renews that token (Google has warned
that third-party tools reading it this way can get accounts flagged). agy's own
read asks Google about twelve times, one after another, which usually takes
5–10 seconds and longer on a first start, on Windows, for a newly added account
or behind a slow network or proxy, so the plugin gives it 45 seconds. Magpie
waits 20 seconds for a read: past that the account says agy is still reading
its quota, agy reads on, and the next refresh shows what it read without
running agy again. A read that doesn't finish in 45 seconds says so, names a
slow network or proxy as the usual cause, and is tried again a minute later.
When agy refuses `/usage` for the account's region ("not currently available
in your location"), the plugin asks agy acp which tier it serves the account
on. Google can name a tier the account can't have (the free one, in a region
it isn't offered in) beside the paid one it is served on, and agy's print
mode and `agy models` refuse on that alone while agy's ACP server and its
terminal UI serve the account. With a tier, the plugin starts agy's terminal
UI in a terminal of its own, with a status line for that run only
(`--settings`, never saved), takes the quota agy hands the status line, and
stops agy; nothing is typed into it and no prompt is sent. The model list
then comes from what agy acp offers (plugins#1602). With no tier, the
account shows agy's refusal and no numbers. On Windows, where the plugin has
no terminal to give agy, the refusal stays.

While Antigravity's app has its gateway on (`gateway.enabled` in
`~/.gemini/config/config.json`, as when magpie takes over Antigravity), agy
reads the same file and goes to that gateway instead of your Google account,
so `/usage` gets only `groups: []`. Since 0.1.148 every agy the plugin starts
(turns and usage) gets a folder without the gateway: the bridge's own when
the sign-in is in the system keyring, and
`~/.local/state/magpie-agy-bridge/agy-own` when it is a file in `~/.gemini`
(no keyring, or over SSH). That folder links every entry of `~/.gemini`;
only `config/config.json` differs, without `gateway` and `models`. Your
`~/.gemini` is not changed (plugins#1591).

While agy's access token has ended or ends within two minutes (with a refresh
token to renew it), agy isn't run for usage: a renewal that fails there can
open a Google sign-in in the browser (#1234). The account says agy's sign-in is
due to be renewed; agy renews it on the account's next chat and the quota is
read after that. Until then the last quota read stays shown.

A signed-out agy opens Google's sign-in page in the browser when it runs, so
before running agy for usage or the model list, the plugin looks at agy's stored
sign-in in the system keychain (macOS) or Credential Manager (Windows) and only
reads whether one is there and when it ends. With none, with one that has ended
and can't be renewed, or with one agy already failed on, agy is not run: the
account shows its sign-in has expired until you sign in again. A usage read that
ran out of time is tried again a minute later; other failed reads wait 10
minutes before the next try, doubling up to 6 hours.

On macOS, a Magpie run as a LaunchDaemon is outside your login session and
can't read your login keychain, and neither can agy there. An account of agy's
own then runs with the copy of its sign-in the Magpie window kept (see above);
one with no copy says why: run Magpie with `magpie daemon install` (a service of
your own) or the Magpie app instead, or sign it in with "Add another Google
account", which keeps its sign-in in a file.

## Environment variables

| Name | Default value | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum number of agy processes in the pool |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to stop forwarding thought summaries |
| `AGY_BRIDGE_EFFORT` | unset | Force a thinking level: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | off | **⚠️ Ban risk, not recommended.** Set to `1` to drop agy's own prompt components, so requests upstream no longer look like the official agy client's; a user reported their account banned within hours of turning it on. See "Minimal agent" below |
| `AGY_BRIDGE_TELEMETRY` | off (agy reports nothing) | The bridge starts agy with `--disable-telemetry` when agy's `acp --help` lists it; set to `1` to keep agy's own reporting |
| `AGY_BRIDGE_ALLOW_AGY_TOOLS` | off | Set to `1` to start every `agy acp` with `--dangerously-skip-permissions`, so agy's own tools (shell, file edits, browser) auto-approve instead of the bridge refusing each `session/request_permission`. Client `ide-tools` still run under the client's own permissions. agy's tools run on the computer magpie runs on, with your user's rights, for every request that reaches this provider: a client on another machine, or anyone holding a gateway key, can run commands there. Leave off unless only you use it |
| `AGY_BRIDGE_SYSTEM_APPEND` | off | Set to `1` to append the client's system prompt to agy's own instead of putting it in the first prompt; see below |
| `AGY_BRIDGE_IDLE_MS` | 600000 | How long a process may sit idle before it is reclaimed; the session can still resume |
| `AGY_BRIDGE_SPARE` | on | Keeps one spare agy per account, started but with no session and no request sent, so a new conversation skips agy's start; set to `0` to turn it off |
| `AGY_BRIDGE_STATELESS_REUSE` | on | A request that is not streamed, has no tools and only one message (describing an image, writing a title) opens its session in an idle agy that answered one such request, skipping the seconds agy's first session takes; that earlier conversation replays its history if it goes on. The same tool-less opening sent again, streamed or not, opens a new session in its own idle agy. Set to `0` to turn it off |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | How long a reclaimed session stays resumable (6 hours) |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | Where resumable session records are kept |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | After this long, a still-running client tool gets a "still running" reply |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | Limits for process startup, agy silence, and waiting on a client tool result |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | How long a suspended tool turn whose client disconnected may keep its pool slot |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for one prompt (agy cuts a prompt at 128 KiB) |
| `AGY_BRIDGE_MAX_REPLAY_BYTES` | the model's window less its output and 32K tokens, at 2 bytes a token (384 KiB for a model the plugin doesn't know) | Byte budget for history replayed into a new session, over as many prompts as it takes (agy 1.5.17+); history past it is left out and the model is told |
| `AGY_BRIDGE_STRICT_REPLAY` | off | Set to `1` to refuse a new session whose replay would leave out or cut any of the conversation: the request gets a 400 "prompt is too long" (`context_length_exceeded`, not retried) and nothing goes to agy, so the client can compact instead of the model answering from part of the history |
| `AGY_BRIDGE_SEED_REPLAY` | on | Set to `0` to send a replay as one prompt of `AGY_BRIDGE_MAX_PROMPT_BYTES`, as before 0.1.139 |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 45000 | Time agy gets for its own usage read, capped at 120000 |
| `AGY_BRIDGE_STORED_SIGNIN` | unset | `skip` stops the plugin from reading agy's stored sign-in |
| `AGY_BRIDGE_MCP_TRACE` | unset | Writes MCP channel traffic to the given file; for debugging only |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` for the plugin's agy processes | agy's own variable. When you set it, agy gets your value; see "Requirements" |
| `AGY_BRIDGE_PREFILL` | on | Set to `0` to restore the stock 400 reject for assistant prefill tails; see "Assistant prefill" |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | English system note | The note line rendered before a prefill fragment (sent to the model) |

## Minimal agent (`AGY_BRIDGE_MINIMAL_AGENT=1`)

> **⚠️ Ban risk, not recommended.** With it on, requests go upstream without
> agy's own system prompt, so they no longer look like the official agy
> client's, and the point of this plugin is that requests are sent by the
> official client and look like it. A user reported their account was banned
> within hours of turning it on. That is one report, not proof of cause, but
> treat the risk as real. While it is on, the plugin prints the same warning to its
> log, once a process. If you turned it on, unset it to go back to the
> default.

By default agy runs every request with its own system prompt, and the
client's system prompt goes as `<external_system_instructions>` at the start
of the first prompt. Antigravity answers a bare 429 to a growing set of
agents' prompts appended to agy's own (since 11-15 Claude Code's "You are an
interactive agent that helps users with software engineering tasks.", even
as "You're …"), while the same account answers with agy's prompt alone, so
agy's `systemPrompt.append` is no longer used by default.
`AGY_BRIDGE_SYSTEM_APPEND=1` goes back to it (in the session, when agy
advertises it). The cost: the client's system prompt shares the first
prompt's byte budget with replayed history (`AGY_BRIDGE_MAX_REPLAY_BYTES`),
and agy's context compaction may summarise it.

Antigravity answers a 429 "Resource has been exhausted" to a few system
prompt lines whatever quota is left (Claude Code's billing line, the Claude
Agent SDK, Codex, Hermes Agent, OpenCode and pi identities, oh-my-pi's RFC
2119 line). The
plugin leaves the billing line out and rewords the others with the same
meaning before agy sends them ("built on the Claude Agent SDK by Anthropic",
"built on GPT-5", "RFC 2119 key words: …", "You're Hermes Agent / OpenCode /
a coding agent running in the Codex CLI", "running within pi"), as the
Antigravity provider does (`cloak.mjs`). Codex's two GPT-5 lines
("You are Codex, a coding agent based on GPT-5", "You are Codex, an agent based on GPT-5")
are turned away in a user's turn too (AGENTS.md, a `<system-reminder>`),
so they go as "built on GPT-5" there as well. Zero-width spaces no longer help:
since 11-14 Google's check reads past them. Reworded in the first user turn
(the default), Claude Code's prompt is answered; in agy's session
instructions (`AGY_BRIDGE_SYSTEM_APPEND=1`) it is still turned away. So a
bare 429 there is reported as a 400 about the prompt, and in the user turn
as a rate limit the client can retry or another account can take.

DeepSeek Harness's paragraph on `@` paths ("Tokens prefixed with @ are
paths…") goes reworded with the same meaning, as the Antigravity provider
sends it: word for word, it got most `gemini-4-argon` answers fast, without
thinking and shallow (#1028). DeepSeek Harness's first line, "You are an AI
agent powered by DeepSeek Harness." (#1171), and "The browser provides no
implicit DOM, route, or screenshot context." in its Web GUI paragraph
(#1105) get the 429 as written too, so they go as "You're …" and "The
browser gives …".

agy reads a command name anywhere in a prompt as the user running that
command: `/learn` (or `/plan`, `/goal`, …, or a skill of the session's)
between spaces, or at the start or end, gets the command's whole text added
to the turn. A system prompt or a skill list that names one, as Cindy's
"invokes /learn or /skill:learn in Pi" does, started agy's `/learn` on every
turn (#1294). So in everything the plugin hands agy, such a name gets a word
joiner (U+2060) after its `/`, which agy doesn't read as a command and the
model reads as the same word; a tool call that copies it goes to the client
without it. Paths, URLs, `/learn.`, `/Learn`, `` `/learn` `` and
`/skill:learn` aren't commands to agy and go as written.

Set to `1`, the temporary agent carries `excludeDefaultComponents: true`. The
request that goes upstream then has none of agy's own system prompt, only
the plugin's one-line tool note and the client's system prompt (sent in one
of the two ways above). The original author measured about 8,400 input
tokens per model call with agy's prompt and about 500 without. The cost is
that upstream no longer sees agy's own request shape, a ban risk (see the
top of this section), which is why it is off and not recommended.

## Troubleshooting

- **agy cannot be found**: click Sign in in Magpie to have it installed (Magpie
  0.1.4246 or later), set `AGY_PATH` to the executable, or make sure `agy` is
  on PATH.
- **Sign in fails, or agy reports a login problem**: click Sign in again, or run
  `agy` in a terminal to sign in there.
- **"You do not have a valid license of this product" (#3501)**: Google refuses
  this account, and agy in a terminal gets the same answer. The plugin says so
  in the model list on the Providers page and in the request's HTTP 403, instead
  of offering the static catalog as if the account had those models. Try:
  update agy and sign in again (Sign in in Magpie, or run `agy` in a terminal,
  then /logout and /login); use a personal Google account (@gmail.com) rather
  than a Workspace one; unset `AGY_ADC_AUTH` if it is set; turn off a VPN or
  proxy that puts you in a region Antigravity isn't offered in.
- **HTTP 503**: the pool is full. Raise `AGY_BRIDGE_MAX_PROCS` and the Providers
  page Concurrency, or reduce the number of simultaneous sessions.
- **Usage shows "Limits not available" or a version error**: that window has no
  measurable data. For a version error, upgrade agy to 1.1.11 or later.
- **Image requests return HTTP 400**: the running agy does not advertise image
  support (1.5.0 or later is needed). Only inline base64 is accepted; image URLs
  are rejected.
- **Documents**: agy reads text and images only. A text document (plain text,
  base64 text/JSON/XML) goes as its text, and a URL document goes as its URL,
  for the model to fetch with a tool. A PDF read by a tool reaches the model as
  a note to extract its text another way; a PDF attached to the message itself
  gets HTTP 400 saying so. Paste its text or attach its pages as images instead.
- **A reply contains "Agent execution terminated due to error."**: that is agy's
  in-band error marker. The plugin reads the real cause from agy's log and ends
  the turn with an error instead of passing the marker through as text. agy
  1.5.8's "There was a network issue connecting to the server" and "Your AI
  credits balance is too low to continue." end the turn the same way (the
  latter as a rate limit), and its `⚠ API error (attempt N)` retry lines are
  dropped. So are the three lines agy writes into the reply when its own output
  cap triggers a retry ("Your previous response was cut off because it exceeded
  the output token limit", its instruction to continue, and "Retries
  remaining: N"); the model's continuation after them still reaches the client.
  agy 1.5.12's retry after a malformed function call ("Your previous response
  contained an improperly formatted function call: …", "Please retry with a
  properly formatted function call", "Retries remaining: N") is dropped the
  same way, as is a banner, or a quota or high-traffic ending, right after
  another banner, or split across chunks at the start of the reply.
  An ending that says "This service has been disabled in this account
  for violation of Terms of Service" (agy 1.5.9 puts "PERMISSION_DENIED
  (code 403):" before it, 1.5.10 doesn't) is returned as a no-retry
  `permission_error` with 403 semantics, not as normal reply text. So is the
  "Verification Required" ending (Google wants the account verified), with
  the link to verify it at when agy logged one, else where to verify it.
  The "⚠ Individual quota reached. … Resets in 1h18m40s." ending (the
  account's own quota is used up) ends the turn as a rate limit
  (`rate_limit_error`, HTTP 429 without streaming) carrying agy's words and
  reset, so magpie rests the account until then and asks the next one.
  The "⚠ Third-party quota reached. Please switch to Gemini models … Resets
  in 3h22m19s." ending (the account's Claude and GPT-OSS quota is used up,
  Gemini's is not) ends the turn the same way, so magpie rests that model
  until then, asks the next account or model, and keeps asking this
  account's Gemini models.
  The "⚠ Our servers are experiencing high traffic right now …" ending
  (Google has no capacity for the model now, and agy's own retries met the
  same 503) ends the turn as `overloaded_error` (HTTP 503 without
  streaming), so the account is not rested and magpie tries again or
  elsewhere. Found by ifccod, and ported from their patch.
- **A reply with only thinking, no text and no tool call** (billion-context's
  "the turn degenerated again after the continuation nudge"): when one of the
  model's replies comes back empty, agy writes "⚠ Model produced invalid
  output." and tries again; when that try is empty too, agy ends the turn as
  finished. The plugin doesn't hand such an ending over as the reply: it asks
  once more in the same session, where the model still has the whole context.
  Still empty, the turn ends with an error, so magpie asks the next account,
  and the client sending the request again continues in that session. An
  empty ending with no thinking either is returned as it is.
- **HTTP 409 saying tool results do not match the history**: usually the client
  rewrote the history or tool IDs mid-conversation. When the plugin can work out
  the correct match it rebuilds the session; when it cannot, it refuses rather
  than guessing. Hermes Agent writes one batching `tool_call({"calls": [...]})`
  into its history as one call per entry; the plugin folds those back into the
  one call agy made, with one result (#1150).
- **Turning thought summaries off**: set `AGY_BRIDGE_THINKING=0`, or send
  `thinking: { "type": "disabled" }` with the request.

## Development

```sh
bun test packages/agy-cli        # from the repo root
bun scripts/check.mjs agy-cli
```

The tests run the full ACP and MCP path against a fake agy (an ACP stdio server
under `test/`), so they never start the real agy and use no quota.

## License

MIT. Copyright notices live in [LICENSE](LICENSE); upstream provenance and the
list of changes are in [NOTICE.md](NOTICE.md).
