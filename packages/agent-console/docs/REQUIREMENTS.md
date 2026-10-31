# Agent Console Requirements v1.0

> This document is the single requirements baseline for v1.0.

## 1. Product positioning

Agent Console is a local AI coding-agent workbench that runs inside Magpie. It brings the Agents already installed and signed in on this machine (Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh) into Magpie, so the user can assign work to an Agent as **project → conversation**, watch what it is doing in real time, control it at any moment, and review its changes.

**Target experience**: broadly the same core experience as the open-source projects Paseo and T3 Code, delivered as a Magpie plugin. The code is our own; only their ideas and protocol usage were referenced.

## 2. Product principles

1. **Agents stay resident**: while a conversation is open the Agent process keeps running; sending a message does not restart it. This is the prerequisite for a good experience.
2. **Projects are the entry point**: every conversation belongs to a project (a local folder).
3. **The conversation timeline is the main stage**: the other panels (changes, files, terminal) exist to help understand and review the Agent's work.
4. **Simple by default, expand on demand**: tool steps and thinking are collapsed by default; failures, permission requests and questions are prominent by default.
5. **Agent differences stay inside adapters**: the frontend only knows unified events and a unified capability description.
6. **Don't re-implement the Agent's own login, model routing or billing**: reuse the local Agent's configuration (including the configuration Magpie applies to it).
7. **Local first**: listen on localhost only; data is stored locally.
8. **Windows is the primary platform**, while macOS/Linux keep working.
9. **Security and process cleanup come before new features**.
10. **Usability over size**: mature dependencies are allowed, but each needs a reason and a pinned version.

## 3. Scope

### 3.1 v1.0 must support
- Opening and using it in Magpie; reloading the page or switching Magpie pages does not affect running Agents.
- Projects: create (pick a folder), rename, remove, open in file explorer.
- Conversations: create, rename, archive, delete (to the trash directory), search, pin; grouped by project.
- Agents: resident sessions for Claude Code (SDK), Codex (app-server) and the ACP Agents (Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh); a Mock Agent (for development). Providers can be enabled/disabled in settings.
- Live output: streamed text, thinking, tool steps (read/edit/write/command/search/web/subtask/MCP), command output, line-level diffs, todos/plans, usage.
- Control: interrupt (keeps the session), send while running (queue or steer), resume (continue the same conversation after a daemon restart or idle reclaim), retry.
- Switching: model, thinking level and permission mode can be changed at any time during a conversation.
- Slash commands reported by each Agent are available in the composer.
- Permissions: four permission modes; when permission is needed a permission card appears in the conversation, and the Agent continues immediately after allow/deny.
- Plan mode and questions: when the Agent submits a plan it can be "implemented/rejected"; when the Agent asks a question the user can pick an option or type an answer.
- Attachments: paste/drag images; very long pastes become text attachments automatically.
- Workbench panels: changes (git status and diff, discard changes per file), file tree and preview, terminals (multiple).
- Import existing local Claude Code / Codex conversations into the matching project.
- Command palette (Ctrl+K), keyboard shortcuts, settings.
- Session data from older versions (r3/r4) is migrated into viewable, resumable conversations.

### 3.2 After v1.0 (not required for this version)
- A known-Agent list with user-defined Agents in settings, plain-text fallback.
- Rewind to a specific turn (Claude file checkpoints / Codex thread/rollback).
- Conversation branching (fork).

### 3.3 Out of scope
- Mobile, remote access/relay/tunnels, multiple hosts, accounts and cloud sync, voice, scheduled tasks, exposing an MCP server, plugin marketplace, multi-Agent orchestration, git worktree management, PR/code-hosting integration.

### 3.4 External dependencies
- Problems with the Agent's own login, network or model gateway (e.g. the Codex gateway reporting an unsupported region) belong to the user's environment; the plugin shows the error clearly and as-is, and must not modify the Agent's configuration files to work around it.

## 4. Architecture

```
Magpie plugin page (sandbox iframe, opaque origin)
  └ page/boot.js → navigates to http://127.0.0.1:<port>/ (single-file React frontend app/)
        ⇅ WebSocket /ws (JSON messages + binary terminal frames); HTTP only for static files, uploads, health checks
Magpie plugin host (Bun)
  └ index.mjs: only starts/reuses the background daemon; no business logic in the host
Local background daemon (separate Node process, Node ≥ 20)
  ├ WS gateway (hello token auth, RPC, subscription push)
  ├ AgentManager (resident sessions, state machine, queueing, idle reclaim, restart recovery)
  │   ├ ClaudeProvider: the local claude executable over stream-json (no SDK)
  │   ├ CodexProvider: codex app-server (JSON-RPC over stdio)
  │   ├ ACP providers: Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh (Agent Client Protocol over stdio)
  │   └ MockProvider (development/testing)
  ├ Timeline (unified events, 60ms stream coalescing, persistence, replay)
  ├ GitService / FileService / TerminalService (node-pty, separate child process)
  └ Storage (JSON + JSONL in the data directory)
```

- Frontend: React + TypeScript, bundled by esbuild into a **single classic script** (ES modules can't be loaded in the sandbox).
- Daemon: TypeScript, bundled by esbuild into `daemon/dist/`, run by Node.
- The daemon does not exit when the page closes; it exits by itself once all conversations are idle and there has been no connection for the configured time (default 60 minutes).

## 5. Functional requirements

### 5.1 Agents and sessions
- Agent detection: name, executable path, version, availability, reason when unavailable and an install hint; results are cached for 60 seconds and can be re-detected manually.
- Capabilities: `resume`, `interrupt`, `steer`, `models`, `effort`, `modes`, `images`, `plan`, `questions`, `cost`, `rewind`. The frontend shows/hides controls by capability.
- Session states: `initializing → idle ⇄ running`, `error` on failure, `closed` when there is no process but it can be resumed. The state is shown live in the sidebar and the conversation header.
- Only one turn runs per conversation at a time. Sending while running: **queue** by default (sent automatically after the current turn; can be edited/removed before sending); Ctrl+Enter **steers** (merged into the current turn immediately if the Agent supports it, otherwise queued with a notice).
- Interrupt: takes effect within 1 second, the session is kept, and the user can continue immediately.
- Idle reclaim: after the conversation has been idle for more than 30 minutes (configurable) the Agent process is released and the state becomes `closed`; the next send resumes automatically.
- Daemon restart: conversations that were `running` are marked `closed`, the timeline gets "daemon restarted, this turn was interrupted", and unanswered permission requests are voided.
- Model, thinking level and permission mode: switchable at any time; when a change needs the session to be rebuilt, the daemon resumes with the original session id automatically, invisible to the user.

### 5.2 Permission modes (four unified levels)

| Unified level | UI name | Claude Code | Codex (approvalPolicy / sandbox) |
|---|---|---|---|
| `plan` | Plan (read-only) | `permissionMode: "plan"` | `on-request` / `read-only` |
| `default` | Ask | `permissionMode: "default"` + permission callback | `on-request` / `read-only` |
| `acceptEdits` | Accept edits | `permissionMode: "acceptEdits"` + permission callback | `on-request` / `workspace-write` |
| `bypassPermissions` | Full access | `permissionMode: "bypassPermissions"` | `never` / `danger-full-access` |

- ACP Agents expose their own modes; the UI shows each Agent's original mode names (e.g. Copilot: Agent / Plan / Allow All).
- When permission is needed, the Agent pauses and a permission card appears in the timeline: a one-line summary + key details (command, file path, diff preview) + the options the Agent offers (usually "allow once / allow for this conversation / deny").
- While waiting, the composer shows "waiting for your confirmation"; stopping the task returns all pending permission requests as cancelled; there is no timeout auto-approval.
- In "Full access" the composer shows a clear danger hint.
- Default level: new conversations default to `default` (changeable in settings).

### 5.3 Plans and questions
- Claude's `ExitPlanMode` and Codex's plan updates show as plan cards (Markdown); a plan submitted in read-only plan mode offers "implement (switch to Ask and continue) / reject".
- Claude's `AskUserQuestion` and Codex's `requestUserInput` show as question cards: option buttons + free input.

### 5.4 Projects and conversations
- Project = a registered local folder; a conversation's working directory is the project folder (the composer has no separate directory picker).
- Sidebar: "+ New project" and search at the top; below, a two-level "project → conversation" tree; project rows have a collapse arrow, an initial-letter tile and a conversation count, with "+ New conversation" and "⋯" on hover.
- New conversations can only start from a project: the project row's +, the project menu, or Ctrl+N (current project). With no projects, only "New project" is offered.
- Conversation title: generated from the first 40 characters of the first message; can be renamed manually, after which it is no longer overwritten.
- Removing a project moves its conversations to the trash directory (recoverable) and never touches the project folder on disk.
- Import history: the project menu's "Import existing conversations" lists local Claude Code / Codex sessions for that directory; checked ones are imported as `closed` conversations that can be resumed.

### 5.5 Timeline display
- User messages (with attachment thumbnails), body text (Markdown, code highlighting, copy), thinking (collapsed by default), tool step groups (summary line, expand for each step, expand again for details), command output (terminal style), line-level diffs, todos/plans, permission cards, question cards, error cards (with stderr details and retry), and an end-of-turn line (duration, tokens, cost, files changed this turn).
- Long conversations stay smooth: virtualized list; a 5000-event conversation opens in ≤ 1 second and scrolls without noticeable jank.
- Streaming: the daemon coalesces every 60ms, the frontend commits per frame and reveals at a steady pace without jumps.

### 5.6 Composer
- Auto-growing text box; Enter sends, Shift+Enter inserts a newline (can be set to Ctrl+Enter to send); nothing is sent during IME composition.
- A row of controls: Agent and model (one popover), thinking level, permission mode, attachment button; send/stop and a run timer on the right.
- Attachments: paste/drag/pick images (≤ 10MB each); pasted text over 32KB becomes a text attachment; sending is blocked until uploads finish.
- While running: shows the queue (editable, removable); Ctrl+Enter steers.
- Once a conversation has an Agent session, the Agent can't be changed (the model can).

### 5.7 Workbench panels (right side, collapsible, resizable)
- **Changes**: the project's git status (modified/added/deleted/untracked); click a file to see its diff (unified view); "Discard changes to this file" (with confirmation); refreshes automatically at the end of a turn and every 3 seconds while visible. Non-git projects show "Not a git repository".
- **Files**: project file tree (lazy-loaded, hides `.git` and `node_modules`); click a file to preview it (text ≤ 1MB, code highlighting).
- **Terminal**: xterm.js; multiple terminals; working directory is the project folder; PowerShell by default on Windows; terminals survive a page reload and keep the last 5000 lines; closing the panel doesn't end the terminal.

### 5.8 Command palette and shortcuts

| Key | Action |
|---|---|
| Ctrl+K | Command palette (projects, conversations, actions) |
| Ctrl+N | New conversation in the current project |
| Ctrl+L | Focus the composer |
| Ctrl+B | Toggle the sidebar |
| Ctrl+J | Toggle the right panel |
| Ctrl+` | Open a terminal |
| Esc | Close popovers; with no popover and focus in the composer, interrupt the run |
| Ctrl+Enter | While running: steer |
| ↑ (empty composer) | Recall the previous message |

### 5.9 Settings
- Send key, default Agent, default permission mode, default thinking level, send-while-running behavior (queue/steer), show thinking, timeline density, theme (follow Magpie/light/dark), language, enabled providers, idle reclaim time, data directory (read-only), version info.

## 6. Unified events (timeline items)

Each item: `{ seq, ts, threadId, turnId?, type, ... }`; `seq` increases monotonically within a conversation.

| type | Main fields | Persisted |
|---|---|---|
| `user_message` | `text, attachments[]` | yes |
| `turn_started` | `turnId, model, mode, effort` | yes |
| `assistant_delta` / `reasoning_delta` | `itemId, text` | no (memory only, pushed after coalescing) |
| `assistant_message` / `reasoning` | `itemId, text` | yes |
| `tool_call` | `itemId, kind, title, status(running/ok/failed), input, detail, output, exitCode, durationMs` | yes (written at start and end, merged by itemId) |
| `tool_output_delta` | `itemId, text` | no |
| `plan` | `itemId, markdown, entries[]` | yes |
| `todo` | `items[{text,status}]` | yes |
| `permission_request` | `requestId, title, kind, detail, options[{id,label,kind}]` | yes |
| `permission_resolved` | `requestId, optionId?, cancelled?` | yes |
| `question` / `question_answered` | `requestId, questions[], answers?` | yes |
| `usage` | `inputTokens, outputTokens, cacheReadTokens, costUsd, contextWindow?` | yes |
| `notice` | `level, message` | yes |
| `turn_ended` | `turnId, status(completed/interrupted/failed), durationMs, error?, filesChanged?` | yes |
| `status` | `status` | no (snapshot field) |

- `kind` values: `read | edit | write | bash | search | glob | web | task | mcp | todo | other`.
- Tool output over 20KB is truncated and marked; body text and thinking are never truncated.
- Every turn ends with exactly one `turn_ended`.

## 7. Protocol (WebSocket)

- Address: `ws://127.0.0.1:<port>/ws`. The first frame must be `{"t":"hello","token":"…","v":1}`; a wrong token closes the connection immediately (close code 4401).
- Client → daemon: `{"t":"req","id":n,"m":"method","p":{…}}`, `{"t":"ping"}`.
- Daemon → client: `{"t":"res","id":n,"ok":true,"r":…}` / `{"t":"res","id":n,"ok":false,"e":{"code","message"}}`, `{"t":"evt","ch":"channel","d":…}`, `{"t":"pong"}`.
- Channels: `sidebar` (project and conversation list changes), `thread:<id>` (timeline events and state), `terminal:<id>` (binary frames).
- Errors are always `{ code, message }` with a human-readable message.
- Automatic reconnect on disconnect (1s→2s→4s… capped at 10s); after reconnecting, gaps are filled by `seq` with no loss or duplication.

## 8. Security

- Listen on `127.0.0.1` only; the Host header must be `127.0.0.1:<port>` or `localhost:<port>`.
- Page token: generated randomly at startup and handed to the page out of band (URL fragment); static responses carry no `Access-Control-Allow-Origin`; the WebSocket first frame is checked against the token; the HTTP upload endpoint checks the `x-agent-console` header.
- **`Origin: null` must be allowed** (the Magpie sandbox page has an opaque origin; rejecting it gives a blank page); other explicit external origins are rejected.
- Child processes never go through a shell; arguments are passed one by one; prompts never go on the command line.
- File APIs only allow paths inside registered project directories (checked after resolving the real path).
- The frontend renders text only through React; Markdown output is sanitized by DOMPurify; links are limited to http/https.
- Request body ≤ 50MB (uploads), regular messages ≤ 200KB.
- When the daemon exits, it ends all Agent and terminal process trees.

## 9. Data

Data directory: `$XDG_CONFIG_HOME/magpie/agent-console/`, or `~/.config/magpie/agent-console/` when unset. Development and tests always use a separate data directory under `_tmp/`.

```
daemon.json            { pid, port, token, version, startedAt }
settings.json
projects.json          [{ id, name, path, createdAt }]
threads/<id>/meta.json
threads/<id>/timeline.jsonl
attachments/<id>.<ext>
trash/                 deleted conversations, conversations of removed projects, legacy data backups
logs/daemon.log
```
- meta is written atomically (temp file + rename); JSONL is appended serially; corrupt lines are skipped; unknown fields are preserved when reading settings.
- Legacy `sessions/<id>/` and the `projects` in `settings.json` are migrated to the new structure; the original data is copied to `trash/legacy-<date>/`.

## 10. Quality and acceptance

- Automation: `npm run build`, `npm test` and `npm run check` (type checking) all pass.
- Performance: sending again in an open conversation starts output in ≤ 1 second (excluding model thinking) without starting a new process; interrupt ≤ 1 second; a 5000-event conversation opens in ≤ 1 second; the minified frontend `app.js` is ≤ 3MB.
- UI rules: font sizes 12/13/14px (empty-state title 18px); the accent color is only used for the send button, selected state, running indicator and focus ring; ≤ 3 divider lines on the first screen; shadows only on popovers; no horizontal scrolling at the 480px minimum width; light and dark both work and `--magpie-*` tokens are preferred.
- Windows manual checks: see `docs/VERIFY-windows.md`.

## 11. v1.0 definition of done

- Opening the plugin in Magpie shows the new UI, connected to the resident daemon over WebSocket.
- Claude Code works end to end: multi-turn without restarting the process, interrupt, permission cards, plan mode, switching model/permissions, resume.
- The Codex pipeline works (app-server start, thread creation, messaging, permission callbacks, interrupt); external gateway errors are shown clearly.
- The ACP Agents work: sessions, models, thinking levels, modes, slash commands, permissions.
- Project/conversation management, attachments, queue/steer, changes panel, files panel, terminal, history import, command palette and settings all work.
- Legacy data is migrated.
- Automated tests and the acceptance checklist pass.
