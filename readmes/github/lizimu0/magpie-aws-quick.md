[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick — Use your own Amazon Quick (AWS Quick) account in magpie

Turns **your own** Amazon Quick sign-in (browser OAuth or desktop login) into a [magpie](https://github.com/yetone/magpie)
provider (`aws-quick`), so agents routed through magpie — Claude Code, Codex,
Gemini CLI, OpenCode, etc. — can use the models behind Quick
(see `magpie models | grep aws-quick`).

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
   sends `session_connect` (with desktop `tf()`/`nf()` fields) and
   `federate_status`, waits for `session_established`/`connected`, then sends
   `user_message`. Uplink frames are binary
   `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}`;
   downlink frames are AWS event-stream messages (`:event-type=rawOutputEvent`,
   body likewise base64-wrapped inner JSON). An application-level `ping` goes
   out every 45s, matching the desktop client.
4. **Protocol translation**: OpenAI `messages` are rendered into Quick's
   `text` (below) — caller system instructions ride the desktop composer's
   `custom_prompt` field (verified live: `custom_prompt` is the field the server
   applies and persists on the thread; reused turns keep `custom_prompt`
   whenever it fits alongside the delta to preserve rule salience and prompt
   cache hits, and omit it only when a large delta needs the full 64 KB frame);
   downlink `text_delta`/`thinking_delta`/`turn_usage`/`message_complete` become
   OpenAI `content`/`reasoning_content`/`usage`. A user turn ends at
   `message_complete` with `continuation_expected !== true` — the same
   rule the desktop renderer uses.
5. **Thread reuse (on by default)**: exact continuation tracking over an
   incremental hash chain — see [Thread reuse](#thread-reuse) below.

### Thread reuse

Quick keeps conversation history server-side per `thread_id`, but OpenAI
clients resend the entire transcript on every request. This plugin tracks
continuations exactly instead of guessing:

- **Incremental hash chain** — each request computes `h[k] = H(scope,
  m1…mk)` over the canonically rendered message list. A cache hit means
  the client appended to a conversation we already answered, so only the
  new tail (user turns / tool results) goes upstream; Quick's server-side
  history supplies the rest and its prompt cache stays warm.
- **Scope isolation** — the chain is namespaced by
  `H(account, agent_mode, thinking_effort, system prompt, tool names)`:
  switching accounts, models, effort, system prompt, or the toolset
  starts a fresh thread rather than resuming a stale one.
- **Edit & branch detection** — any change to earlier messages alters the
  hashes, so edited or branched history can never silently continue a
  thread that doesn't match; only append-only tails qualify. Cached
  entries are claimed on use (single-use), so a client retry cannot
  replay a turn.
- **Bounded memory** — entries expire after 30 minutes and the store is
  LRU-capped at 200 threads; nothing touches disk.

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
maps to `thinking_effort`: `off/low/medium/high` (`max`/`xhigh` cap to `high`,
matching the desktop client).

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
magpie plugin add <this directory or git URL>
magpie login aws-quick        # pick a sign-in method when prompted
```

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
- **本地凭据（Local credentials）**: on Windows reads the app's session from
  Credential Manager and chats directly (OIDC auto-refresh, write-back keeps
  the app's tokens valid); elsewhere or on failure it boots the bundled
  outpost and calls `/auth/sncs-session` — a clear error tells you to sign in
  to the app first if it isn't.

## Known limitations

- **Client-side commands & tool calls**: When Quick tries to run a terminal
  command (`tool_start` for `run_terminal_command`), the plugin maps it to the
  client's declared shell tool (e.g. `Bash`) as an OpenAI `tool_calls` entry so
  Claude Code / Codex executes it locally, then returns the output upstream in
  a `tool_result` frame. Other client-declared tools ride the `<tool_call>`
  text convention (`lib/tools.mjs`) with `tool`-role results rendered as
  `[tool_result …]` on the same thread. Quick's other internal tools (browser,
  cloud files, etc.) are not mapped.
- **Images/attachments**: `user_message` supports `attachments`, but v1 only
  renders text; image parts become `[image omitted]` placeholders.
- **Sampling params**: `temperature` etc. don't exist in the protocol and are
  ignored server-side (`capabilities.temperature:false`).
- **Sessions are account-bound**: the thread-reuse scope includes an account
  identity hash; switching accounts transparently invalidates old threads.
- **Concurrency**: different threads can run turns in parallel on one
  QuickSocket; concurrent requests on the same thread are rejected (`busy`).
- **OAuth sign-in is consumer/social only**: it replays the desktop app's
  `quick.aws.com/sn` flow (`social` provider). Enterprise-IdP tenants whose
  issuer is not the Amazon social IdP may not complete this flow — use the
  local-credentials method on a machine with the app installed instead. Because
  browser OAuth has no local outpost, the plugin persists a stable generated
  `outpost_id` UUID per account.
- **Message size**: the whole `user_message` frame is hard-capped at 64 KB
  server-side (`text` + `custom_prompt` share it). Oversized system prompts /
  tool schemas / history are compacted automatically (schema de-annotation,
  compact typed signatures / lite / names-only fallback, oldest-first history
  trimming, water-filling per-block budgets across single or parallel tool
  results); truncation is surfaced as a `> [quick] …truncated` note.

## Security & credentials

- The instance token is randomly generated per launch and passed to the child
  **only** via stdin — never written to disk or logs.
- On the local-credentials path, `id_token`/`ws_host`/`actor_arn` etc. live
  only in memory; session-cache keys store hashes only.
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
  to the user cache directory (`%LOCALAPPDATA%\magpie-aws-quick\agent\<size>-<mtime>\`
  on Windows / `~/Library/Caches/magpie-aws-quick/` on macOS /
  `~/.cache/magpie-aws-quick/` on Linux), overridable via the `cacheDir` option.

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

Questions, suggestions, or want to tinker together? Come say hi on
**[linux.do](https://linux.do)**.
