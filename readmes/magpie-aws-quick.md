[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick — Use your own Amazon Quick (AWS Quick) account in magpie

Turns **your own** Amazon Quick sign-in (browser OAuth or desktop login) into a [magpie](https://github.com/yetone/magpie)
provider (`aws-quick`), so agents routed through magpie — Claude Code, Codex,
Gemini CLI, OpenCode, etc. — can use the models behind Quick
(see `magpie models | grep aws-quick`).

> **Recommended clients: Claude Code or pi (pi-agent).** The plugin is
> developed against these two. In Claude Code, tool calls, thread reuse
> across turns, interrupts and large file writes are tested end-to-end; pi's
> session-affinity headers are used to keep reusing the same Quick thread.
> Other clients work too, but get less testing.

> **Prefer the native Quick desktop app?** [aws-quick-manager](https://github.com/httpdone/aws-quick-manager)
> switches accounts in the official Quick app in one click and copies chat
> sessions between accounts through Quick's cloud API, with no reverse proxy.

> ⚠️ For personal use with your own account only. This drives the desktop
> client's internal bidirectional WebSocket protocol (not a public API) and
> very likely violates AWS terms of service; your account may be limited or
> banned. Use at your own risk.

## How it works

magpie has a real plugin mechanism: it loads **OpenCode provider plugins** in
Bun. This project is exactly such a plugin:

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie gateway 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ this plugin's fetch ──▶ wss://<qbs-cell>/streaming/quickwork-chat-bidirectional-stream
```

The key point: **no packet capture, no proxy, no app patching**. The Amazon
Quick desktop app already bundles a Python backend (`quickwork-agent`, packed
in `resources/agent.zip`). Run standalone with `--outpost-only`, it exposes
local endpoints — `/health`, `/auth/status`, `/auth/sncs-session`,
`/local/outpost-id` — on `127.0.0.1:<port>`, and it can read the login state
the desktop app stores in the system credential store.

What the plugin does:

1. **Finds and starts the outpost**: prefers the `quickwork-agent` the app
   already extracted into userData; otherwise extracts `resources/agent.zip`
   to a temp dir and runs it. It hands the child a **self-generated instance
   token** over stdin (the same contract as the Electron main process's
   `AgentBridge`), then waits for `/health`.
2. **Gets a session**: `GET /auth/sncs-session` returns
   `{id_token, ws_host, actor_arn, …}`; `GET /local/outpost-id` returns the
   device id. Cached until `usable_until`, refreshed automatically.
3. **Connects the chat WS**:
   `wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`
   (query: `surfaceType`/`token`/`outpostId`/`workingSessionId`/`channel`),
   sends `session_connect` (waits for `session_established`/`connected`),
   then `user_message`. Uplink frames are binary
   `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}`;
   downlink frames are AWS event-stream messages (`:event-type=rawOutputEvent`,
   body likewise base64-wrapped inner JSON). A `ping` goes out every 25s.
4. **Protocol translation**: OpenAI `messages` are rendered into Quick's
   `text` (below) — except the system prompt, which rides the dedicated
   `user_message.custom_prompt` field (verified live); downlink
   `text_delta`/`thinking_delta`/`turn_usage`/`message_complete` become
   OpenAI `content`/`reasoning_content`/`usage`. A user turn ends at
   `message_complete` with `continuation_expected !== true` — the same
   rule the desktop renderer uses.
5. **Thread reuse (on by default)**: exact continuation tracking over an
   incremental hash chain — see [Thread reuse](#thread-reuse) below.

Device ids: the desktop app always sends its profile's `device_id` as `outpostId`, so direct sessions send a stable per-account one too instead of an empty value. Credential Manager sign-ins reuse the desktop profile's own `device_id` (read-only); OAuth accounts get a UUID generated once at sign-in and stored on the account record, kept across token refreshes and re-logins. The same id goes into oversized-image delivery. Accounts never share an id, and an id is never rotated. `stableDeviceId: false` goes back to the empty value. The local-outpost backend uses whatever id Quick's own agent reports; the agent inherits `QUICKWORK_BASE` / `QUICKWORK_ROOT` from the environment.

### Thread reuse

Quick keeps conversation history server-side per `thread_id`, but OpenAI
clients resend the entire transcript on every request. This plugin tracks
continuations through three tiers, most precise first:

- **Incremental hash chain** — each request computes `h[k] = H(scope,
  m1…mk)` over the canonically rendered message list. A cache hit means
  the client appended to a conversation we already answered, so only the
  new tail (user turns / tool results) goes upstream; Quick's server-side
  history supplies the rest and its prompt cache stays warm.
- **Fuzzy anchors** — when a client extension prunes or rewrites old
  turns (compaction, history surgery), the strict chain breaks. The
  plugin then matches position-independent anchors: the echo of our own
  last reply plus the three messages that preceded it. Position drift
  from trimming doesn't matter; a rewritten tail still starts fresh.
- **Gateway session key** — as a last resort, a stable session id the
  gateway stamps on every request of a chat (magpie's
  `x-magpie-session` header; OpenAI clients like pi also send their own
  session-affinity headers) identifies the conversation even when
  history was rewritten beyond recognition. The entry rewrites itself
  every turn, so aggressive compaction can't strand it.

Tier order matters: verified content matches always win; the session key
is only used when both content tiers fail.
- **Scope isolation** — the chain is namespaced by
  `H(account, agent_mode, system prompt)`: switching accounts, models or
  system prompt starts a fresh thread rather than resuming a stale one.
  Thinking effort is a per-turn field and doesn't split threads; tools are
  tracked per thread, so a tool added mid-session (Claude Code's ToolSearch,
  skills) keeps the thread and only the new tool's spec is sent.
- **Failure-safe** — a reused turn that errors or is cancelled (499, content
  filter, idle timeout) puts its thread back, so the next request still
  continues it. The session-key fallback only resumes when the new tool
  results answer calls that thread made, so parallel subagents sharing one
  session id never splice into each other's threads.
- **Edit & branch detection** — any change to earlier messages alters the
  hashes, so edited or branched history can never silently continue a
  thread that doesn't match; only append-only tails qualify. Cached
  entries are claimed on use (single-use), so a client retry cannot
  replay a turn.
- **Bounded memory** — entries expire after 24h idle (agent sessions pause
  far longer than that between turns) and the store is LRU-capped at 200
  threads. The cache persists to `thread-sessions.json` (hashes + thread
  ids only, no content) so reuse survives plugin reloads; a stale hit is
  safe — the handler retries once on a fresh thread with the full
  transcript.

### Models: agent_mode, not model ids

Quick's `user_message` selects a tier via `agent_mode`; the server routes to a
concrete model (`resolved_model_id`/`served_model_id` in `turn_usage`):

| magpie model id | agent_mode | observed resolved_model_id (example) |
|---|---|---|
| `fast` | fast | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | (server-routed) |
| `smart` | smart | `us.anthropic.claude-opus-5-5` |
| `advanced` | advanced | (may normalize to smart) |

The `X-Magpie-Effort` header (or body's `reasoning_effort`/`thinking_effort`)
maps to `thinking_effort`: `off/low/medium/high/max`.

## Install

### 1. Requirements

- **magpie** (the OpenCode plugin host).
- **One of two sign-in paths** (pick at `magpie login`):
  - **Browser OAuth** — nothing else needed. The plugin replays the app's own
    OIDC+PKCE login in your browser and chats on the stored token directly.
    Works on machines without the desktop app, and without administrator rights.
  - **Local credentials** — the Amazon Quick **desktop app** installed and
    **signed in** (`%LOCALAPPDATA%\Programs\quickwork\` on Windows — i.e.
    `C:\Users\<you>\AppData\Local\Programs\quickwork\`; `/Applications/Amazon Quick.app`
    on macOS). On Windows the plugin reads the app's stored session directly
    from Credential Manager — **no agent.exe, no outpost** while the token is
    fresh; expiry is covered by OIDC refresh with write-back so the desktop
    app keeps working. On other platforms (or if the read fails) it falls
    back to spawning the bundled `quickwork-agent --outpost-only`, which
    reuses the app's login state — **the desktop app does not need to stay
    running**; the session lives in the OS credential store.
- **Node ≥ 22**: only needed to run tests; the plugin itself is pure ESM with
  zero third-party dependencies.

### 2. Install the plugin

```bash
magpie plugin add magpie-aws-quick   # from npm; or a local directory / git URL
magpie login aws-quick              # pick a sign-in method when prompted
```

In the magpie app, search "Amazon Quick" under **Plugins** and install it from
there.

**Alternative: standalone OpenAI-compatible proxy** — `node bin/serve.mjs`
serves the same adapter on `127.0.0.1:$PORT/v1` (default port 3426) for
clients that don't go through magpie, or to add Quick as a custom magpie
provider via `magpie provider add --base-url http://127.0.0.1:3426/v1`.
See the file header for options (`PROXY_TOKEN` auth recommended).

**Sign-in methods**

- **账号登录（Browser OAuth）**: opens `quick.aws.com/sn`, waits on a localhost
  callback, performs client registration + code exchange itself, then stores
  `{jwt, ws_host, refresh_token, …}` in
  `%APPDATA%\magpie-aws-quick\oauth-sessions.json` (Windows) /
  `~/.config/magpie-aws-quick/` (Linux) /
  `~/Library/Application Support/magpie-aws-quick/` (macOS), mode `0600`.
  The ~1-hour id_token is auto-refreshed via the stored refresh token
  (rotation persisted). No outpost is spawned at request time — the chat
  WebSocket goes straight to the tenant's `ws_host`.
- **复制登录地址（Copy sign-in link）**: the same browser OAuth flow, but
  magpie opens nothing — copy the link into the browser you sign in to
  Amazon with, then paste the address-bar URL into the box magpie shows.
  On another computer the browser can't reach the `127.0.0.1` callback: the
  first paste saves the account info and asks you to start again — the
  second paste finishes the login (saved info valid for 15 minutes).
- **本地凭据（Local credentials）**: on Windows reads the app's session from
  Credential Manager and chats directly (OIDC auto-refresh, write-back keeps
  the app's tokens valid); elsewhere or on failure it boots the bundled
  outpost and calls `/auth/sncs-session` — a clear error tells you to sign in
  to the app first if it isn't.

### Usage on the account card

The plugin implements magpie's `auth.usage` hook, so the account card and the
**Usage** page show the account's Quick quota: agent hours used of the plan's
allowance, the plan name (e.g. *Quick Lite (free trial)*) and the trial's
expiry. It reads `getAvailableEntitlementUnits` from the tenant data plane
with the account's own token — the same numbers as the desktop app's usage
widget, which also assumes the allowance resets on the 1st of next month.

### Options

A few plugin options tune request handling (`magpie plugin options aws-quick '{…}'`):

- `headerWaitMs` (default `10000`): streaming requests return response headers
  after Quick's first output **or** this long, whichever comes first — Quick
  can sit silent while its own tools run, and gateways cap how long they wait
  for headers. `0` waits for the first output as before.
- `idleTimeoutMs` (default `300000`): abort a turn that shows no Quick progress
  (real events; keepalives don't count) for this long — surfaces as a 503
  `timeout` error, and Quick gets its own `stop_generation` frame so the turn
  doesn't keep running server-side. Client aborts are handled the same way.
  `0` disables the watchdog.
- `showQuickTools` (default `true`): surface Quick's built-in tool activity
  (`tool_start`) as `[Quick: <name>]` reasoning lines so long agentic turns
  don't look dead; `false` hides them.
- `stableDeviceId` (default `true`): direct sessions send a stable
  per-account device id as `outpostId` (see Device ids above); `false` sends
  an empty value.

## FAQ

**After signing in to a second account, the first one stopped working.**
You most likely signed out of the first account in the same browser before
signing in to the second. Signing out revokes that account's credentials, so
the plugin can no longer refresh it. Sign in each account in a different
browser or in a private/incognito window, without signing out of the others.

## Known limitations

- **Tool calls are a text-convention simulation**: Quick's agent owns a
  server-side toolchain (browser, local files, MCP, …); its `tool_start`/
  `tool_result` events are executed by Quick itself while clients only observe,
  and `message_complete.tool_calls` is always empty. OpenAI `tools` sent by
  the client are injected as a `<tool_call>{json}</tool_call>` text convention
  and parsed back into standard `tool_calls`; `tool`-role results render as
  `[tool_result …]` continuing the same thread. The full tool spec is sent
  once per thread; later turns on a reused thread carry only a short
  reminder, because everything in the message stays in Quick's thread
  history and counts toward the context. Reliability depends on the
  model honoring the convention — verified stable under
  `tool_choice:'required'` for smart/advanced; occasionally the model answers
  directly with its own tools (e.g. web search) instead, which shows up as a
  plain-text reply. If the model instead invokes a client-declared tool
  through Quick's own native tool channel, the plugin recognizes the call and
  emits it as a normal `tool_calls` item, stopping the turn before Quick can
  rewrite it as text. Quick's built-in tool results are never mapped to OpenAI
  `tool_calls` (that's its internal process).
- **Images: small ones inline, larger ones uploaded.** Inline images (`data:`
  URLs, Anthropic base64 blocks, images inside tool results) that fit the
  frame go as `user_message.attachments` base64; bigger ones (up to 3 MiB
  each, 4 per turn, 5 MiB total, inline data only) are uploaded through
  Quick's own attachment flow and land in the account's cloud session
  workspace — the same place the Quick app puts them. Remote URLs and
  non-image files (`file`/`input_file` parts) are still unsupported; a
  failed upload falls back to a note telling the model the image is
  missing. Cloud upload works on direct sessions (OAuth / Credential Manager
  sign-in) and on the local-outpost fallback: outpost sessions carry the same
  `id_token` / `ws_host`, which is all the upload flow needs (verified live).
- **Sampling params**: `temperature` etc. don't exist in the protocol and are
  ignored server-side (`capabilities.temperature:false`).
- **Sessions are account-bound**: the thread-reuse scope includes an account
  identity hash; switching accounts transparently invalidates old threads.
- **Concurrency**: different threads can run turns in parallel on one
  QuickSocket; concurrent requests on the same thread are rejected (`busy`).
- **OAuth sign-in is consumer/social only**: it replays the desktop app's
  `quick.aws.com/sn` flow (`social` provider). Enterprise-IdP tenants whose
  issuer is not the Amazon social IdP may not complete this flow — use the
  local-credentials method on a machine with the app installed instead. The
  OAuth path sends a stable generated device id but runs no local agent, so
  any server feature that needs a connected device (local files/apps) won't
  apply.
- **Message size**: the whole `user_message` frame is hard-capped at 64 KB
  server-side (text, instructions and attachments share it). Oversized system prompts /
  tool schemas / history are compacted automatically (schema de-annotation,
  tool-spec lite then names-only fallback, oldest-first history trimming,
  capped tool results). Ordinary chat keeps full system instructions when they fit alongside the
  encoded turn. Claude Code Auto permission reviews require the complete policy
  and transcript in one frame. An oversized review returns HTTP 413 before
  contacting Quick. In Claude Code, Manual mode lets you approve tool requests.

## Security & credentials

- The instance token is randomly generated per launch and passed to the child
  **only** via stdin — never written to disk or logs.
- On the local-credentials path, `id_token`/`ws_host`/`actor_arn` etc. live
  only in memory; session-cache entries store only hashes + thread ids —
  persisted to `thread-sessions.json` (no message content) so thread reuse
  survives plugin reloads.
- On the OAuth path, `{jwt, refresh_token, client_secret, …}` is persisted in
  `oauth-sessions.json` (mode `0600`) — unavoidable for refresh-token
  rotation, equivalent to the desktop app keeping its sign-in in the OS
  credential store. Protect your user profile accordingly.
- The Credential-Manager path only **reads** the session the app already
  stored; on refresh it **writes the new tokens back to the same credential**
  (including the `session@` twin) so the desktop app always sees valid
  tokens — equivalent to the app refreshing early on our behalf.
- Every outpost `/auth/*` endpoint requires
  `Authorization: Bearer <instance token>`; `/health` is the only public one.
- The plugin never modifies any Amazon Quick files; `agent.zip` is extracted
  to a temp dir (`<tmp>/magpie-aws-quick/agent/<size>-<mtime>/`), overridable
  via the `cacheDir` option.

## Development

```bash
npm test          # node --test test/*.test.mjs (fake WS server, no real account)
node _research/smoke-plugin.mjs fast   # live smoke (needs Quick signed in locally)
```

Protocol details in [PROTOCOL.md](PROTOCOL.md). Research notes and captures
live in `_research/` (not shipped with the plugin).

## License

MIT. Amazon Quick is an AWS product; this plugin is not affiliated with
Amazon/AWS.

## Community

Questions, bug reports, suggestions, or want to tinker together? Issues and
pull requests are very welcome — **[linux.do](https://linux.do)** is the
best place to find me and the community around this plugin.
