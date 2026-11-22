[English](PROTOCOL.md) | [中文](PROTOCOL.zh-CN.md)

# Amazon Quick Chat Protocol (verified on v1.2.4660)

This document records the wire protocol the plugin relies on. All fields come
from reverse-engineering the desktop `app.asar` (`dist/main`, `dist/renderer`)
plus live traffic captures. Sensitive values (tokens, account ids, tenant
URLs) are always placeholders.

## 1. Topology

```
magpie ──OpenAI Chat Completions──▶ plugin fetch
                                      │ spawn / connect
                                      ▼
                        quickwork-agent --outpost-only  (Python, 127.0.0.1:<port>)
                          ├─ /health                  public
                          ├─ /auth/status             Bearer <instanceToken>
                          ├─ /auth/sncs-session       Bearer <instanceToken>
                          └─ /local/outpost-id        Bearer <instanceToken>
                                      │  id_token + ws_host
                                      ▼
              wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
              (qbs-cell…dp.appintegrations.<region>.prod.plato.ai.aws.dev)
```

Instance-token contract (same as Electron `AgentBridge.pipeToken`): the main
process writes the token as the **first line** of the child's stdin; every
later `/auth/*` and `/local/*` request uses `Authorization: Bearer <token>`.

## 2. Outpost launch arguments

```
quickwork-agent(.exe) --outpost-only --manifest desktop --port <port>
```

Environment variables (the minimal set the plugin sets):

| Variable | Purpose |
|---|---|
| `QUICKWORK_BUILD_STAGE` | `prod` (default) / `beta` etc.; selects the feature-flag channel |
| `QUICKWORK_CLOUD_MODE` | `1` |
| `QUICKWORK_OUTPOST_PORT` | listen port |
| `QUICKWORK_PROFILE_STAGE` | same as build stage |
| `QUICKWORK_USER_DATA_DIR` | optional; points at app userData to reuse local state |

stdout prints lines like `OUTPOST_PORT: <port>`, `LEP_PORT: <port>`.
`/health` returns `{"status":"ok","service":"outpost"}`.

## 3. Session endpoints

### `GET /auth/sncs-session`

Returns (fields sanitized):

```json
{
  "id_token": "<JWT>",
  "actor_arn": "arn:aws:quicksight:…:user/…",
  "ws_host": "qbs-cell….dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
  "tenant_url": "https://qbs-cell…dp.appintegrations…",
  "provider": "social",
  "aws_account_id": "…",
  "embed_host": "https://quick.aws.com",
  "region": "us-east-1",
  "usable_until": 1763…,          // epoch seconds; re-fetch after expiry
  "ws_replay_enabled": true
}
```

### `GET /local/outpost-id`

```json
{ "outpostId": "<uuid>" }
```

Device/session-reuse dimension; required by both the WS URL and
`session_connect`. (There is also a `nook-set-outpost-id` IPC that pushes it to
the renderer's invokeAgent path.)

## 4. WebSocket

### 4.1 URL

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=QUICK_WORK_DESKTOP_WINDOWS
  &token=<id_token URL-encoded>
  &outpostId=<uuid>                 // always present on the desktop URL
  &workingSessionId=<uuid>          // stable for the life of the client
  &channel=prod                     // appended only for beta or prod
  [&agentRuntimeArnOverride=…]      // enterprise path only; not needed for social
```

The social/AIDP path needs **no SigV4 signing** (that is what the enterprise
provider's `nook-sign-ws-url` IPC does).

### 4.2 Uplink frames (client → server)

WS binary frame; payload is UTF-8 JSON:

```json
{ "eventType": "rawInputEvent",
  "payload": { "payload": "<base64(utf8(inner JSON))>" } }
```

Inner JSON looks like `{"type": "…", "payload": {…}}`. Common types:

**session_connect** (send immediately on connect, then `federate_status`; wait for
`session_established`/`connected` before sending messages):

```json
{ "type": "session_connect",
  "payload": {
    "actor_id": "<actor_arn>",
    "surfaceType": "QUICK_WORK_DESKTOP_WINDOWS",
    "outpostId": "<uuid>",
    "appVersion": "1.2.4660",
    "acp_first_text": 1,
    "user_notification": 1,
    "subtask_progress": 1,
    "external_agent_sign_in": 1,
    "recents_promotion": 1
  } }
```

**user_message**:

```json
{ "type": "user_message",
  "payload": {
    "thread_id": "<client-chosen id, e.g. uuid>",
    "text": "<the whole user input>",
    "custom_prompt": "<caller system instructions (kept on reused turns when it fits, omitted when a large delta needs the full frame)>",
    "message_id": "<uuid>",
    "agent_mode": "fast|balanced|smart|advanced",
    "user_timezone": "UTC",
    "user_locale": "en-US",
    "thinking_effort": "off|low|medium|high",   // desktop caps max at high
    "chat_agent_id": "…",                            // optional
    "project_context": {…}, "attachments": […],     // optional, unused by plugin
    "web_search_enabled": true, …                   // optional
  } }
```

**ping** (desktop application interval is 45s):

```json
{ "type": "ping", "payload": { "timestamp": <ms> } }
```

### 4.3 Downlink frames (server → client)

AWS event-stream messages (12-byte prelude + headers + payload + 4-byte CRC;
headers carry `:message-type=event`, `:event-type=rawOutputEvent`,
`:content-type=application/json`). The body is JSON:

```json
{ "payload": "<base64(utf8(inner JSON))>" }
```

Inner-JSON top-level fields: `type`, `payload`, `message_id`, `thread_id`,
`scope` (`chat`/`task_lifecycle`…), `timestamp`, `turn_message_id`.

Observed event types (excerpt):

| type | Meaning |
|---|---|
| `session_established` | ack for `session_connect` (carries `workingSessionId`, `trace_id`) |
| `connected` | session ready; `payload.user`/`runtime` carry account & warm-up info (**contains PII — do not log**) |
| `status` | misc status, e.g. `{"status":"pong"}`, `unknown_message_type` |
| `message_start` | an assistant message begins (`payload.role:"assistant"`) |
| `text_delta` | `payload.delta` text increment (`kernel_thread_id` inside payload) |
| `thinking_delta` / `thinking_complete` | reasoning increments |
| `tool_start`/`tool_arguments`/`tool_progress`/`tool_result`/`tool_error` | agent tool progress (executed server-side; client only observes) |
| `turn_usage` | `payload`: `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`total_tokens`/`model`/`resolved_model_id`/`served_model_id`/`cost_usd`/`context_window` |
| `text_complete` | `payload.text` full message text |
| `message_complete` | `payload`: `text`, `tool_calls[]`, `kernel_thread_id`, `initiator`, `continuation_expected?` |
| `message_split` | long reply split |
| `title_generated` | conversation title |
| `runs_updated` / `task_list_update` | run/task status noise (top-level `thread_id` empty; `payload.thread_id` has the value) |
| `keepalive` | `{"type":"keepalive","ts":…}` |
| `error` / `guardrail_blocked` / `stream_truncated` / `turn_aborted` | failures |

### 4.4 Turn termination (verified)

**There is no `turn_completed` downlink event** (that is a persisted event
type in the REST session store). A user turn ends by the same rule the desktop
renderer uses:

- `message_complete` with `payload.continuation_expected !== true` → the last
  message of the turn is done; agentic multi-step turns emit several
  `message_start…message_complete` cycles where earlier rounds carry
  `continuation_expected:true`;
- `stream_ended`, `turn_aborted` → terminate immediately;
- `error`/`guardrail_blocked`/`stream_truncated` → failure.

`message_complete`/`text_complete` `payload.text` is a full-text fallback;
normally `text_delta` already delivered everything.

### 4.5 Thread reuse

The server persists conversation history by `thread_id` (verified: a second
turn on the same thread remembers the first). The client picks `thread_id`
(plugin uses UUIDs). See the README's "thread reuse" section for the reuse
rule.

### 4.6 Client tool calls (convention simulation)

The protocol has **no** client-tool channel: `tool_start`/`tool_arguments`/
`tool_result` are Quick's own agent tools executing server-side, and
`message_complete.tool_calls` is always empty. The renderer's tool
approval/result return (`tool_approval`, `{"type":"tool_result",…}`) only
serves its own tool loop — an external `user_message` cannot inject a
"pending client tool call".

The workable bridge (adopted by the plugin, verified end-to-end):

1. Render OpenAI `tools[]` + `tool_choice` into a `[Client tool calling]`
   instruction block prepended to `user_message.payload.text` (reused turns
   send only a short 1-line reminder), with the client tool rule kept at the
   front of `custom_prompt`. Also set `web_search_enabled:false` to reduce the
   model "answering first" with its own web-search tool.
2. The model emits calls as plain text
   `<tool_call>{"name":…,"arguments":{…}}</tool_call>` (tags may split across
   `text_delta`s; the plugin does holdback parsing — see `lib/tools.mjs`).
3. Parsed results map to OpenAI `tool_calls` with `finish_reason:"tool_calls"`.
4. When Quick emits a terminal `tool_start`/`tool_arguments` (such as
   `run_terminal_command`) and the client declared a shell tool (e.g. `Bash`),
   the plugin maps it to an OpenAI `tool_calls` entry and returns the client's
   result upstream in a `{"type":"tool_result",…}` frame on the same thread.
5. Other client `role:"tool"` results → rendered as
   `[tool_result <name> <id>] <content>` continuing the same thread (the delta
   only carries new tool/user content).

Limits: relies on the model honoring the convention (`tool_choice:'required'`
verified stable); the model may also ignore it and answer with its own tools
(shows up as plain text); Quick's built-in tool results are never mapped to
OpenAI `tool_calls`.

## 5. agent_mode → actual model

| agent_mode | observed resolved_model_id |
|---|---|
| `fast` | `us.anthropic.claude-haiku-5-5` |
| `smart` | `us.anthropic.claude-opus-5-5` |
| `balanced`/`advanced` | server-routed; `advanced` may normalize to `smart` (renderer feature-flag logic) |

`turn_usage.model` echoes the requested mode; `resolved_model_id`/
`served_model_id` are the real model. Note Quick's system prompt is large:
measured `input_tokens≈67k`, `cache_read_tokens≈67k` (prompt-cache hit),
`context_window=1000000`.

## 6. Known pitfalls

- After `session_connect`, wait for `session_established`/`connected` before
  sending `user_message`, or the message may be dropped (observed as silence).
- `user_message` only gets an answer after the outpost finishes its first
  agent sync; a fresh outpost spends ~30–60s on feature-flag/agent reconcile —
  that is normal.
- If sandbox port 8768 or the LEP port is taken, the outpost degrades and keeps
  running (only affects local tools/MCP sandbox; the chat WS is unaffected).
- `connected.payload.user` contains email/name/account id — **do not print raw
  events**.
- The whole `user_message` frame has a 64 KB cap (the server rejects larger
  with `FrameTooLarge`; `text` + `custom_prompt` share it),
  which the plugin budgets in `lib/handler.mjs`/`lib/translate.mjs`/
  `lib/tools.mjs`; rendered payload always stays <60 KB.
