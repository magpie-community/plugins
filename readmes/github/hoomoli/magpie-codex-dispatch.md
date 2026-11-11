# magpie-codex-dispatch

[中文说明](README.zh-CN.md) · [Ownership contract / 控制权规范](docs/ownership.md)

Current release version: **0.0.13** — guarded automatic task archival after review and required integration, historical snapshot render normalization, retained background execution, event-driven Claude review, and stored-history status. Permanent deletion and direct archival of desktop-owned chats remain outside the supported scope.

The display name is `magpie-codex-dispatch`; the version belongs in Magpie’s separate version badge. Local-directory installs hide that badge, so use `codex_plugin_info` to verify their loaded version. Git-based installs also show a commit identifier managed by Magpie.

To check the version actually loaded by Magpie, ask Claude to call `codex_plugin_info`, or run:

```sh
magpie tool magpie-codex-dispatch_codex_plugin_info --json
```

It returns `pluginVersion` and `loadedAt` (module load time). These values are captured at load, so editing files alone does not make an old host claim the new version. All successful tool results include the current host's `pluginVersion`, including replayed receipts; this does not change the original receipt's identity. Reload the plugin after updating and check this tool again. The local checkout is versioned; a Git tag or package publication is a separate release step.

**English:** A Magpie plugin for creating project-specific Codex conversations, handing off idle Companion sessions, and dispatching tasks with live execution in the native Codex desktop app.

**中文：** 通过 Magpie 新建指定项目的 Codex 会话、安全交接空闲会话，并在 Codex 桌面应用原生对话中实时执行任务。

```text
Claude / other MCP client
  -> existing Magpie MCP gateway and plugin host
    -> background worker: create, verify permissions, execute
    -> catalog event: ordinary sidebar refresh without navigation
    -> native follower stream: progress, approvals, follow-up and stop
    -> completion event: wake Claude for review
```

By default, new tasks execute in a detached worker using the app-bundled AppServer. The worker verifies effective permissions, publishes native follower snapshots, and forwards approvals and guarded interruptions. The desktop displays progress without a separate dashboard. Existing desktop-thread dispatch and explicit Companion handoff retain their native-owner path. Background tasks are not opened automatically. `executionMode: "desktop"` opens the new chat and uses its verified native owner. Pinning is opt-in through `pin: true` on `codex_create_task`.

Release acceptance remains **CLOSED**. Publication was requested by the owner; unresolved findings and incomplete live acceptance remain documented. All required local checks passed; see the [0.0.13 release record](docs/verification.md).

## Install and connect Claude

Requires macOS, a running Codex desktop app, and Magpie with community plugin tools enabled:

```sh
magpie plugin add github:hoomoli/magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

Local development:

```sh
git clone https://github.com/hoomoli/magpie-codex-dispatch.git
magpie plugin add ./magpie-codex-dispatch
magpie library mcp agents magpie-codex-dispatch claude
```

Magpie writes its plugin-specific HTTP MCP entry into Claude's configuration. Start a new Claude session to pick it up. Use the Library connection **or** a manually configured MCP entry, not both. The address and authentication depend on your Magpie instance; copy its Installed/Library address instead of assuming a port. No model-provider change is necessary.

Ask Claude, for example:

> Use the Magpie Codex tools to create a task in project `my-project`. First list projects. Reuse the same requestId on retries. After acceptance, wait for the configured completion hook to wake this session for review; do not poll. Task: …

For an old Companion session, first stop sending commands to that thread through the old openai-codex integration. Ask Claude to inspect ownership, hand off the idle session, and wait for `desktop_owned`. Subsequent commands use this plugin's follower tools; the desktop remains the writer.

## Local debugging and unloaded status

Install this checkout by absolute path after disabling the existing Git installation, then remove the old Git entry once local loading is verified. Do not leave two enabled copies. `codex_plugin_info.moduleUrl` identifies the loaded source; check `pluginVersion` and `loadedAt` after toggling the local plugin off/on following code changes. Editing files alone does not reload the host.

For threads without a writer, `codex_status` reads stored history through a read-only AppServer instead of waiting for desktop owner discovery. It never resumes a thread. Results explicitly carry `source: persisted-history`, `historyOnly: true`, and `runtimeStatus: notLoaded`; runtime permissions and pending requests remain unknown. Empty/missing turns are not success, and a persisted in-progress turn is not reported as live activity. Explicit historical turn lookup is bounded to 200 turns with `historyTruncated` when exceeded. If a writer attaches during the read, status switches to live desktop lookup. An unattached ownership result does not prove thread existence or deletion.

## Tools

Plugin-specific MCP exposes these names. The combined endpoint prefixes them with `magpie-codex-dispatch_`; inspect `tools/list` for the actual names.

| Tool | Main arguments | Result |
| --- | --- | --- |
| `codex_plugin_info` | none | Loaded plugin version and module load time; no desktop access |
| `codex_projects` | none | Canonical project IDs, names and workspace roots |
| `codex_create_task` | `requestId`, `prompt`; project selection below | Create in background by default; optional desktop ownership for native activity/approval UI |
| `codex_ownership` | `threadId` | Desktop ownership or external/unattached writer information |
| `codex_handoff` | `threadId`, `requestId`, optional `sourceEndpoint` | Release one idle Companion thread, wait for unload and attach desktop |
| `codex_recover_creation` | `requestId`, `threadId` | Verify source marker/project/cwd and bind an uncertain creation; does not dispatch |
| `codex_operation_status` | `requestId` | Read saved create/handoff progress without advancing it |
| `codex_set_permissions` | `threadId`, `requestId`, explicit `permissionMode` | Set and verify the next-turn permissions of an idle thread; starts no task |
| `codex_status` | `threadId`, optional `turnId` | Fresh execution snapshot, current/next-turn permissions and up to 16,000 characters of assistant output |
| `codex_dispatch` | `threadId`, `prompt`, `requestId`, optional `permissionMode` | Start the next turn in an idle native thread |
| `codex_followup` | `threadId`, `turnId`, `prompt`, `requestId` | Steer an active turn |
| `codex_stop` | `threadId`, `turnId`, `requestId` | Request cancellation of the specified active turn |
| `codex_archive` | `threadId`, `requestId` | Archive through a verified idle background owner, or archive an unattached persisted subtree |

### Supported archival scope

See [retained-owner lifecycle](docs/background-owned-thread-lifecycle.md) for the private control protocol, resource policy, failure handling and local acceptance procedure. Explicit handoff relinquishes background ownership and its owner-routed archive capability.

`codex_archive({threadId, requestId})` archives persisted threads through their **verified retained plugin background owner**, or when the root and every discovered descendant have no writer. Background requests are authenticated and routed to the original owning connection; any held descendant is refused. A fresh owner snapshot showing active work or pending input/approval fails with `THREAD_ACTIVE`. Any other holder returns `completed: false`, `submitted: false`, `phase: owner_action_required`, `automaticRetry: false`, and `actionRequired: archive_in_owner`. Stop automatic retries and archive in the owning desktop/client. The same archive request may be retried only after confirmed natural writer release; the plugin does not restart apps or force release.

`completed: true` and `serverAcknowledged: true` confirm the app-server archive acknowledgment; descendant notifications may be incomplete and immediate sidebar refresh is not promised. Verify active/archived inventories independently. An unavailable thread is not proof of cleanup. Plugin locks do not coordinate external clients; avoid concurrent resume/mutation.

Archive preflight failures retain stage/error diagnostics in `codex_operation_status`. Lost mutation replies remain `outcome_unknown`; even the same request ID does not resend an uncertain submission. Inspect the receipt and actual state first.

**Permanent deletion is no longer offered.** `codex_delete` has been removed rather than silently changed into archive. Historical deletion receipts remain readable through `codex_operation_status`, marked `retired: true` without retry advice. A new archive operation needs its own request ID, distinct from an old deletion ID. Resolve unknown old mutation outcomes before another lifecycle operation.

The final native-entry audit found no independently callable desktop archive path meeting the normal-startup requirement: the installed native tools pipe rejected Magpie's Bun peer with `untrusted-code-signing-identity`, and follower IPC has no archive/release request. The plugin does not impersonate official callers or share a backend. See [capabilities and final audit](docs/app-server-capabilities.md). This is an explicit scope reduction, not a claim that desktop-held cleanup was fixed.

### Create in a project

For idle desktop-held chats, a locally verified alternative is to [delegate an explicit archive manifest to a desktop-owned Codex chat](docs/native-archive-bridge.md) using existing create/handoff/dispatch tools. The native turn performs archival; direct plugin archival retains the boundary above. This needs neither shared backend nor special startup. It is an orchestration recipe, not permanent deletion or a released automatic fallback.

```json
{
  "requestId": "example-task-0001",
  "projectName": "my-project",
  "title": "Example task",
  "permissionMode": "read-only",
  "prompt": "Reply exactly OK. Do not use tools or modify files."
}
```

Select an exact unique `projectName` or canonical `projectId` from `codex_projects`. Desktop UI project IDs can differ from backend IDs. One project root supplies the working directory; multiple roots require an explicit `cwd` inside a root. An explicit absolute `cwd` without a project creates a projectless thread. No implicit current-project default is used. Paths are resolved through filesystem aliases and checked before creation. This creates a **conversation**, not a new project.

Optional `title` is limited to 160 characters and defaults to `Magpie task`. In background mode, the new empty thread is archived and immediately restored once, before execution, to produce a genuine catalog event. After the background worker owns the restored thread and starts the task, it forwards that event to refresh the sidebar without navigation. No existing or active user thread is cycled.

### Permission modes

`codex_create_task` accepts optional `executionMode: "desktop"` to open the chat, confirm desktop ownership, and dispatch through that owner for native activity and approval UI. The default `"background"` runs without navigation; unopened background chats do not have native sidebar runtime indicators. Preserve the mode and request ID on retries; changing modes cannot create a replacement task under the same ID. Existing running threads are not migrated or interrupted. See [attention and execution modes](docs/background-attention.md).

`codex_create_task` accepts optional `pin: true` to place the new thread in the native desktop pinned section before execution. Omitted or `false` keeps the existing unpinned behavior. A successful requested pin returns `pinned: true` and `pinConfirmed: true` after server readback; this confirms persisted membership, not visual observation. Unsupported or unconfirmed pinning stops before task submission and preserves the created thread ID in `codex_operation_status`; do not create a replacement automatically. Pinning is applied once: replaying an accepted request or sending later turns does not restore a pin manually removed by the user. Preserve the original `pin` argument and request ID on retries.

Agent policy belongs in local Claude rules rather than the plugin default. Example rule: “For new tasks created through magpie-codex-dispatch, explicitly pass `pin: true` unless the user requests an unpinned task. Do not re-pin on follow-up turns or after manual unpinning. Verify the loaded tool schema supports `pin` before dispatch; if unavailable, reload/update the plugin rather than claiming it was pinned.”

`codex_create_task` and `codex_dispatch` accept `permissionMode`:

| Mode | Behavior |
| --- | --- |
| `inherit` (default) | Preserve existing thread settings; new background tasks use backend defaults, not another desktop chat's selection |
| `read-only` | Read-only sandbox with `on-request` approvals |
| `ask-for-approval` | Workspace-write sandbox with `on-request` approvals |
| `auto-review` | Workspace-write sandbox, `on-request` approvals routed to Codex `auto_review`; eligible requests may be approved or denied |
| `full-access` | Unrestricted filesystem/network access with `never` shell approvals; requires explicit user authorization |

The caller must pass the user's requested mode explicitly when creating a task with a particular permission level. A selection in a different thread is not authorization for every new task. Legacy `sandbox: read-only/workspace-write` maps to the corresponding explicit mode; conflicting fields are rejected. Version 0.2.0 forced workspace-write/on-request by default; 0.2.1 inherits instead.

New background tasks verify the AppServer's effective permissions before turn/start. Existing desktop tasks apply and verify explicit permission settings through their native owner. Default inheritance preserves the backend configuration; it never silently promotes a task to Full Access.

To correct an existing idle thread without starting work, call `codex_set_permissions` with its `threadId`, a unique `requestId`, and `permissionMode: "full-access"` after explicit user authorization. `codex_status.permissions` describes the loaded runtime's current/last-turn permissions; `nextTurnPermissions` describes settings for the next turn. Neither field is a historical permission lookup for an arbitrary `turnId`. A settings-only update may leave these fields different until a new turn begins. Receipts are historical acknowledgements; read status for current settings.

Permission changes persist even if a later preflight fails; inspect status before retrying. The idle check and update are separate private IPC calls: avoid concurrent UI/client submissions or permission changes. Full Access governs shell sandbox/approvals, not every connector authorization, macOS permission, or task clarification.

### Retry and completion

1. Save one request ID per logical operation. IDs contain 8–128 letters, digits, underscores or hyphens.
2. For pending create/handoff phases, wait roughly 2–5 seconds and repeat the **same tool, arguments and requestId**. A tool response can arrive before desktop attachment or source unload finishes. Source unload was observed to take about a minute.
3. On `phase: accepted`, save `threadId` and `turnId`. With the completion hook installed, wait for the event-driven wakeup; do not poll. Use `codex_status` for diagnostics or to inspect a specific turn. Acceptance is not completion.
4. Handle `inProgress`, `completed`, `failed`, `interrupted`, unknown history and approval requests separately. Handle approvals in the native app.
5. A lost mutation acknowledgement is `OUTCOME_UNKNOWN` / `dispatch_unknown`. It is never automatically resubmitted. Inspect status; do not invent a new ID to retry uncertain work.

Operation receipts keep fingerprints, IDs, project/workspace metadata and progress. Background workers additionally keep a private terminal output summary for late notification recovery; input files are private and removed when consumed. The remainder of this paragraph describes legacy native creation recovery. Repeated acknowledged commands return the original receipt, including after restart. Creation lost before saving its thread ID is reconciled using a unique source marker and a bounded metadata scan; if unresolved it stays `creation_unknown` rather than creating a duplicate. The scan examines at most 1,000 list entries and reads at most 30 candidates with omitted markers. Absence is not treated as proof of failure. Empty threads may be omitted from listings or may not yet be persisted upstream. If the original ID is known, `codex_recover_creation` verifies its unique source marker, cwd and project before binding it; then retry the original create arguments. An unreadable thread cannot be recovered or silently recreated.

Legacy handoff progress is advanced by retry calls. New task execution runs independently in its background worker; retries never submit it again. `codex_operation_status` is a saved checkpoint, not a live ownership or completion assertion. Do not delete receipt files: doing so removes replay protection. A verified Companion busy rejection before forwarding records `release_rejected`; retry the same request to recheck the source and try release again. Timeouts, disconnects and ambiguous RPC errors retain the release intent and never automatically repeat unsubscribe.

Native commands acquire a per-thread kernel lock before reading desktop state and retain it through submission and receipt persistence. Create/handoff progress uses a per-request kernel lock. All plugin instances must share the same state directory. Contention returns `BUSY` / `OPERATION_BUSY`; it does not queue work. macOS releases locks when the owning descriptor closes or the process exits, including a crash. Keep the `.mutex` files in place; their existence does not mean a lock is held. Codex's writer-lock files are never modified.

When upgrading from directory-based locks, stop old plugin hosts before loading this version. Dead legacy `.lock` and `.recovery` directories are retained but do not block progress; a live or incomplete legacy owner still requires inspection. These plugin locks do not serialize desktop UI actions or other clients that bypass the plugin.


## Ownership and limitations

- A thread has one writer. Normal Claude ↔ Codex interaction uses the desktop's follower interface and does **not** transfer the writer back and forth.
- Handoff supports the local, current-user **Codex Companion broker** protocol. The plugin verifies the writer's parent broker/socket and its handshake, reads the target's idle status, then sends `thread/unsubscribe` for that thread only. Unknown or active writers are refused.
- Source acknowledgement alone is insufficient: the plugin waits for writer release and a native owner snapshot. It never deletes Codex locks, kills a shared broker, closes unrelated threads or interrupts active work automatically.
- The source must quiesce submissions before handoff. The source API has no atomic “unsubscribe only if idle” guard; a client that ignores this contract can race the check. Arbitrary desktop-to-CLI writer transfer is not provided. Both callers should keep using the native owner via this plugin.
- Desktop takeover uses the supported `codex://threads/<id>` deep link and can bring the app/thread to the foreground. It uses no accessibility automation. If the app retains a stale busy screen, switch away and reopen the thread, or use its Retry action after release.
- Follow-up checks the active turn, but the private steer protocol has no atomic expected-turn guard. Avoid concurrent UI turn replacement. Stop does send `expectedTurnId`; confirm the final state with status.
- Caller cancellation stops waiting; it does not automatically cancel an already accepted task. Each tool call has a 45-second deadline, with bounded IPC/RPC timeouts and subprocess cleanup.

This is an **experimental macOS integration using private desktop IPC** alongside the public [Codex App Server API](https://learn.chatgpt.com/docs/app-server). Desktop updates can break it. Unsupported stream versions fail before dispatch. Windows/Linux desktop support is not claimed.

## Configuration and trust

Set optional environment variables on the **Magpie plugin host**, not only Claude:

| Variable | Default |
| --- | --- |
| `MAGPIE_CODEX_SOCKET` | `~/.codex/ipc/ipc.sock` |
| `MAGPIE_CODEX_STATE_DIR` | `~/.local/state/magpie-codex-dispatch` |
| `MAGPIE_CODEX_BINARY` | Installed desktop's bundled Codex CLI; absolute executable path required |
| `CODEX_HOME` | `~/.codex` for the public client and writer inspection; also set the socket override for a nonstandard desktop home |

Sockets must belong to the current user. State directory permissions are `0700`, files `0600`. The plugin never reads credentials directly or edits Codex session storage; the bundled app-server uses the user's existing Codex setup. MCP access grants local task execution and assistant-output reads: limit it to trusted clients through Magpie. Prompts are limited to 64 KiB and protocol frames to 32 MiB. Raw internal errors and conversation payloads are not included in error messages.

## Claude onboarding and release acceptance

From a new Claude Code session in this checkout:

```sh
npm run acceptance:connect -- --prepare --current-session
```

Have that Claude read/execute the generated `brief.txt`. Use `acceptance:release` for the full matrix and `acceptance:release:check` before publication. A connection pass covers basic create/read/notification integration only. Failures, blocked cases, missing evidence, and changed source snapshots keep the release gate closed. See [entry points](docs/acceptance/README.md) and the [complete matrix](docs/acceptance/claude-release-gate.md).

## Verification and development

No build step. Runtime dependencies are pinned in package-lock.json (MCP SDK for the Claude channel and Immer for desktop state patches). Run npm ci for local checkout installs. Node 22+ for the channel; Magpie supplies Bun for plugin tools. File locking requires the macOS system utility `/usr/bin/lockf` with inherited-file-descriptor support; an unavailable utility fails before submission.

```sh
npm run check
npm test
npm pack --dry-run
npm run probe -- <thread-uuid>
```

The probe reads metadata only. Automated tests use temporary sockets/state and cover routing, busy/changed turns, cancellation, protocol errors, lost replies, creation recovery, project validation and duplicate prevention. See [verification record](docs/verification.md) for actual local acceptance and remaining compatibility limits.

Interface reference: [Magpie plugin tools, v0.1.2785](https://github.com/yetone/magpie/blob/v0.1.2785/docs/subsystems/plugin-tools.md). This independent implementation does not vendor proprietary desktop code.

[MIT license](LICENSE).

## Automatic Claude review

For Claude Desktop Code opened from the Dock, run `node src/install-desktop.js` once, then continue dispatching through Magpie. Native async hooks bind the current session and wake Claude for review when Codex finishes, without model polling or a custom launcher. See [Desktop setup and recovery](docs/desktop-notifications.md). The optional terminal [Channel launcher](docs/channels.md) remains supported.

## Background lifecycle and limitations

The private background directory contains request fingerprints, worker receipts, transient 0600 input files (removed when read), and terminal output summaries. Request IDs are never replayed after uncertain submission. A disconnected desktop is retried with bounded backoff without restarting work. After a turn completes, the worker persists its terminal summary and retains ownership until explicit `codex_archive` or idle `codex_handoff`. At most eight owners per state directory are admitted; additional creation fails before a new thread is created. Archival ACK precedes a genuine desktop notification and resource release. Plugin reload does not terminate retained workers. A crashed owner is never automatically recreated; completion monitoring can still read the exact persisted terminal result. Claude's model does not poll.

An unexpected worker crash does not automatically re-run a task: inspect the saved operation and native thread. Unsupported server requests receive an explicit error, never automatic approval. Desktop approval, input, interrupt and next-turn commands use the same worker while it owns the thread; ordinary desktop ownership can resume after it exits. Private IPC versions are checked and remain app-version dependent. Large histories that exceed the 32 MiB frame limit cannot be streamed by this version; work is not replayed to compensate.

`codex_handoff` still explicitly opens existing Companion sessions. The no-navigation guarantee applies to background-mode `codex_create_task`; desktop mode explicitly opens the new chat. Legacy pending creation IDs are retained and refused for automatic migration rather than duplicated.
