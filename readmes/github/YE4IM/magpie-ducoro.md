# Ducoro 0.4.5

Sync Magpie models, connectors, skills, instructions and explicitly selected subagents to Ducoro, and manage per-Bot assignments from the plugin page. Changes go through previews with confirmation before saving; failures are recorded by category with per-item retry; verification distinguishes saved settings, written configuration, readback and session loading.

Full history: [CHANGELOG.md](CHANGELOG.md) · Release notes: [RELEASE-NOTES.md](RELEASE-NOTES.md).

## Features

### Sync and assignment

- **Models**: follow the Magpie default globally, or assign per Bot with inheritance; unavailable models keep their previous setting and report a pending result. Capability references are matched automatically against Ducoro's official catalog and can be pinned or disabled manually.
- **Connectors**: two sources — Magpie library connectors (global or per Bot) and Ducoro account connectors (connect the service first, then select allowed tools per Bot in the account drawer). Revocations run before additions and connector failures are isolated; the first explicit assignment records the previous policy and revocation restores it; external edits produce conflicts instead of being overwritten. When the current CLI cannot clear a nonempty args/env/headers list or safely change transport, the plugin retains the definition and reports a conflict.
- **Skills**: assigned per Bot from Magpie resources already allocated to Ducoro; skill artifacts with the same name and content digest are prepared once and reused. Skill bundles are bounded by file count (5000) and total size (32 MiB).
- **Instructions and subagents**: instructions are appended inside the plugin-owned block, and removal restores the user's original profile; subagents are selected explicitly per target.
- **Plans**: define a name, model, library connectors, skills and extra instructions under **Bot plans**; multiple Bots inherit continuously and explicit selections take precedence. One click clears per-Bot overrides back to the plan (including instruction overrides). Plan IDs accept 1–64 letters, digits, underscores and hyphens; cancel inheritance before deleting a plan.

### Preview and verification

- **Preview changes** reads the draft without writing; **Save settings** shows a preview and requires confirmation. The preview lists global and per-Bot additions and removals, the resources other Pi Agents are expected to lose when global resources move to per-Bot assignment, each value's source (global settings, inherited plan or Bot override), and a three-way comparison of last-synced, current Ducoro and desired Magpie values.
- Switching targets, disabling sync or deselecting explicitly lists the managed blocks and files scheduled for removal.
- After saving, items are verified across four stages: saved, written, read back and session-loaded. Items without sufficient evidence stay explicitly unverified; a successful command does not prove that a running session loaded the changes. Subagents are verified against the current desired content. Verification continues in the background beyond 35 seconds, reconnects after interrupted polling and resumes when the page reopens.
- Drift handling: models offer adopt-current, reapply-desired or pause model management for that Bot; writes carry the reviewed configuration summary and re-read before applying, keeping the current state on mismatch.

### Tasks and recovery

- A task center groups status, failure category (temporary, permission, conflict, unsupported, corrupt, unconfirmed), attempt count and earliest retry time by Bot and resource, with per-item retry, pause and resume. Temporary failures retry with backoff; the rest wait for manual action.
- Commands run in their own process group: timeouts, cancellation and output limits end the whole tree. Mutations with a lost response are read back before reconciliation.
- Before creating an MCP connector or skill for the first time, the plugin persists recovery intent: after a lost response, ownership is restored only when identity and complete content read back identically.

### Drafts and bulk actions

- Unfinished settings and plan drafts autosave completely through the authenticated local service and are restored against the same settings baseline. Concurrent edits across pages prompt to restore the latest draft instead of silently overwriting; a corrupt draft keeps the original file with guidance.
- Bulk copy stages the source Bot's effective configuration, including inherited plans, into the draft; the latest bulk change can be undone. Account permissions are excluded from bulk copy.

### Backups and rollback

- **Backup management** centralizes management-record backups and configuration checkpoints: create backups, open the backup folder, import external files (8 MiB limit; record imports need a complete v1/v2 snapshot, checkpoint imports accept version 1 records), JSON export and per-collection clearing. Backups support names, notes and retention flags; retained items survive automatic pruning, bulk clearing and local-record cleanup.
- A configuration checkpoint is created before each save (file mode 0600, latest 20 unretained kept). Checkpoints roll back selectively by field and Bot, automatically including related plan definitions, inheritance and scope changes; restores stage a draft for preview before saving.
- Restoring a management-record backup pauses automatic sync until previewed and manually continued; restarting the host does not clear the pause.
- **Clean up local records** previews counts and sizes before confirming: it removes completed operation history (up to 500 records), old state backups (latest 5 unretained kept) and skill caches unused for over 7 days, and compacts the journal. Current ownership, permission-recovery data, unfinished operations and skills in use are retained.

## Installation

Add this folder's absolute path in Magpie's plugin settings, or install the local `magpie-ducoro-0.4.5.tgz` package. Open **Ducoro** in the sidebar. Magpie must support plugin page services, and `ducoro-cli` and the Ducoro daemon must be available locally.

Upgrading: stop the previous host, then replace the plugin path or package before loading the new version, so two versions never write the same management state. Existing settings and compatible v1/v2 records carry forward without reconfiguration.

Downgrading: stop the 0.4.5 host first, then run `npm run state:compact -- /absolute/path/to/state.json` from this package directory to merge the journal under the shared lock. After an interrupted run, recover with 0.4.5 first. Do not manually delete an uncompacted journal.

## Page and assignments

- **Sync settings**: switches for the model connection, models, connectors, skills, instructions and subagents. Disconnect handling and the three resource scopes use switches: off means global sync, on means per-Bot assignment.
- **Bot resources**: three independent scopes for models, connectors and skills; all Bots are listed automatically (names and IDs are read-only; refresh the list). Supports search by name/ID, status filters and unsaved-change counts.
- **Sync diagnostics**: generates a live report on demand, showing the viewing time and the last synchronization time, with explicit stale and in-progress states. Viewing never triggers sync; retry synchronization separately. Shows the current step and its duration, CLI and merged-read counts, and the last 20 in-memory rounds (cleared on restart); issues link straight to the relevant settings area.

The model dropdown is single-select and manages only Pi Agents bound to the plugin connection; other runtimes and connection bindings are not changed automatically. Refreshing retains unsaved choices, and a failed list read is never treated as an empty list. Connectors and skills support inheritance, explicit selection and no assignment; empty lists mean the plugin assigns none and do not block other global or user configurations. Resource scopes are based on plugin ownership records and never count user-installed resources as plugin-owned.

## Service and saving

The page service listens on loopback at `127.0.0.1:3487` by default; change `servicePort` in the plugin options if needed. During reload the service waits for the previous host to release the port, and Magpie web mode uses its page-service proxy. Saving uses Magpie's official page message channel and reloads the plugin host to trigger synchronization. API requests check Host, Origin and the page token; the page receives resource names and status, never connection credentials. Capability checks are feature-specific: command availability alone does not verify server permissions or execution success.

## Language

The page follows the Magpie language setting: Simplified and Traditional Chinese use Chinese; all other and unknown languages fall back to English. Language changes preserve drafts, search, selections and open dialogs. Bot, model and resource names and technical keys keep their original spelling.

## Model capability catalog

Automatic matching uses the official catalog exposed by the installed Ducoro version. **Sync upstream model list** bypasses the five-minute cache, re-reads `ducoro-cli connections catalog` and requests another capability match; search by model or provider to inspect reference IDs, match sources, reasons and context lengths. Newly added models match by exact full ID; route groups require compatible member identities and mixed versions are never forced into a reference. Manual references take precedence and can pin or disable a mapping — remove one to resume automatic matching. Failed reads retain the last valid catalog and references.

## Diagnostics and command line

```sh
node diagnostics-cli.mjs              # live report (English by default)
node diagnostics-cli.mjs --lang zh    # Chinese output
node diagnostics-cli.mjs --json
node diagnostics-cli.mjs --port 3488  # custom page port
node diagnostics-cli.mjs --doctor     # read-only daemon info
```

The CLI reads the live service on demand, prints to the terminal and creates no report files; it reports clearly when the plugin is unavailable. Legacy `sync-status.json`, `total-status.json`, `model-capabilities.json` and their temporary files are removed on startup. Ownership records, page tokens and skill recovery backups are retained.

## Management records and recovery

The default management file is `~/.config/magpie/ducoro-bridge/state.json`; `XDG_CONFIG_HOME` and `DUCORO_BRIDGE_STATE_DIR` can change its location. Small changes append to `state.json.journal` with sequence numbers and checksums, compacting into a snapshot after 128 records or 1 MiB.

Unreadable, corrupt or unsupported records pause synchronization and preserve the original. Check permissions and storage, or preview and restore a valid backup under **Sync diagnostics → Troubleshooting**. Recovery restores management records, not Bot configuration; synchronize manually afterward. Never delete or replace the file with an empty object: it contains the previous permissions needed for safe revocation.

Before lock recovery, stop every plugin host, inspect ownership again and use the latest recovery token:

```sh
npm run lock:inspect -- /absolute/path/to/ducoro-bridge
# After stopping every host and inspecting again:
npm run lock:inspect -- /absolute/path/to/ducoro-bridge TOKEN --all-hosts-stopped
```

## Main options

| Option | Default | Meaning |
| --- | --- | --- |
| `modelScope` | `global` | Global models or `agents` for per-Bot assignment |
| `botModels` | `{}` | Bot ID to model ID; omitted entries inherit |
| `mcpScope` | `global` | Global or per-Bot assignment of Magpie library connectors |
| `skillsScope` | `global` | Global or per-Bot skill assignment |
| `resourceAssignments` | `{}` | Bot ID to `mcp`/`skills` name lists |
| `accountConnectors` | `{}` | Bot ID to connector slug to `{allow, deny}` policy |
| `servicePort` | `3487` | Local page service port |
| `connectionSlug` | `magpie-ducoro` | Plugin model connection slug |
| `modelCapabilityRefs` | `{}` | Manual model capability references |

Plan-related configuration keys: `botPlansCatalog`, `botPlans`, `botInstructions`, `pausedModels`, `modelGuards`. Gateway connections, complete skill packages, instruction blocks and explicit subagents use the existing sync modules; hooks and RTK are not synchronized. Technical keys keep their original names; the UI calls library tools “connectors”.

## Validation scope

Automated regression covers account policy writes, external conflicts, reapplication and restoration, and local HTTP page-service proxy constraints, plus browser checks for backup downloads, plan confirmation, bulk undo and draft recovery. Real account permission writes and the Magpie web proxy still require installation-level acceptance testing; automated checks do not establish real account authorization.

## License

MIT
