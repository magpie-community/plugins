# magpie-ducoro 0.4.10

**English** | [简体中文](https://github.com/YE4IM/magpie-ducoro/blob/main/README.zh-CN.md)

Version 0.4.10 improves the npm installation guide, first-use steps and compatibility notes. Synchronization behavior and management record formats are unchanged from 0.4.9. The npm package is [`magpie-ducoro`](https://www.npmjs.com/package/magpie-ducoro).

Sync Magpie models, connectors, skills, instructions and explicitly selected subagents to Ducoro, and manage per-Bot assignments from the plugin page. Changes go through previews with confirmation before saving; failures are recorded by category with per-item retry; verification distinguishes saved settings, written configuration, readback and session loading.

Full history: [CHANGELOG.md](docs/CHANGELOG.md) · Release notes: [RELEASE-NOTES.md](docs/RELEASE-NOTES.md).

## Requirements

- [Magpie](https://usemagpie.ai) with support for plugin agents and page services (`magpie.agent` and `magpie.page.service`).
- [Ducoro](https://ducoro.ai) installed and signed in, with its background service running. Install its [CLI](https://ducoro.ai/download/cli) and make `ducoro-cli` available on the PATH used to launch Magpie.
- Access to the local Ducoro device and the Bots to manage. The plugin's page service uses `127.0.0.1:3487` by default; choose another `servicePort` if that port is occupied.

The plugin does not install Ducoro or its CLI. Exact minimum Magpie and Ducoro versions have not been established. This documentation release does not claim new end-to-end synchronization verification or Windows/Linux compatibility; confirm the CLI and page-service support on your platform before use.

## Installation

In Magpie, open **Plugins → Add a plugin** and enter `magpie-ducoro@0.4.10`. Alternatively, use Magpie's CLI:

```sh
magpie plugin add magpie-ducoro@0.4.10
```

`npm install magpie-ducoro` downloads the package into an npm project; it does not register the plugin with Magpie. Use the Magpie command or plugin dialog above for normal installation.

For a source installation, download a version from [GitHub Releases](https://github.com/YE4IM/magpie-ducoro/releases), extract it and add its absolute folder path to Magpie. A GitHub version can also be added as `github:YE4IM/magpie-ducoro#v0.4.9`; that tag contains the same synchronization implementation as this documentation patch.

### First use

1. Open **Ducoro** in Magpie's sidebar. If the page is unavailable, check `ducoro-cli`, the background service and the configured page-service port.
2. In **Sync settings**, review the connection identifier, enabled resource types and target Bots. Assign the Magpie library resources you want Ducoro to receive; select per-Bot assignments where needed.
3. Use **Preview changes**, review additions and removals, then **Preview and save** and confirm. Saving reloads the plugin host and starts synchronization.
4. Open **Sync status** and review saved, written, read-back and session-loaded results. Resolve items marked unverified; a successful CLI command alone does not prove a running Bot has loaded the changes.

For a read-only check of the Ducoro background service, run:

```sh
npm exec --package=magpie-ducoro@0.4.10 -- magpie-ducoro-status --doctor
```

Upgrading: stop the previous host, then update the package or replace the plugin path before loading the new version, so two versions never write the same management state. Existing settings and compatible v1/v2 records carry forward without reconfiguration.

Downgrading: stop the current host first, then run `npm run state:compact -- /absolute/path/to/state.json` from this package directory to merge the journal under the shared lock. After an interrupted run, recover with the current version first. Do not manually delete an uncompacted journal.

## Features

### Sync and assignment

- **Models**: follow the Magpie default globally, or assign per Bot with inheritance; unavailable models keep their previous setting and report a pending result. Capability references are matched automatically against Ducoro's official catalog and can be pinned or disabled manually.
- **Connectors**: two sources — Magpie library connectors (global or per Bot) and Ducoro account connectors (connect the service first, then select allowed tools per Bot in the account drawer). Revocations run before additions and connector failures are isolated; the first explicit assignment records the previous policy and revocation restores it; external edits produce conflicts instead of being overwritten. When the current CLI cannot clear a nonempty args/env/headers list or safely change transport, the plugin retains the definition and reports a conflict.
- **Skills**: assigned per Bot from Magpie resources already allocated to Ducoro; skill artifacts with the same name and content digest are prepared once and reused. Skill bundles are limited to 5,000 files, 1,000 directories, depth 64, 10,000 entries and 32 MiB of source content. Each scan has a 10-second budget within the preview's overall 25-second budget. Cancellation also stops byte reads; unreadable bundles retain their existing managed content for review.
- **Instructions and subagents**: instructions are appended inside the plugin-owned block, and removal restores the user's original profile; subagents are selected explicitly per target.
- **Plans**: define a name, model, library connectors, skills and extra instructions under **Manage plans**; multiple Bots inherit continuously and explicit selections take precedence. One click clears per-Bot overrides back to the plan (including instruction overrides). Plan IDs accept 1–64 letters, digits, underscores and hyphens; cancel inheritance before deleting a plan.
- **Target range**: `targetAgents` applies to models, instructions and subagents. Library connectors and skills in per-Bot mode also use this range; their managed resources outside it are revoked. Account connectors remain configured separately for each Bot.

### Preview and verification

- **Preview changes** reads the draft without writing; **Preview and save** shows a preview and requires confirmation. The preview lists global and per-Bot additions and removals, the resources other Pi Agents are expected to lose when global resources move to per-Bot assignment, each value's source (global settings, inherited plan or Bot override), and a three-way comparison of last-synced, current Ducoro and desired Magpie values.
- Switching targets, disabling sync or deselecting explicitly lists the managed blocks and files scheduled for removal.
- After saving, items are verified across four stages: saved, written, read back and session-loaded. Items without sufficient evidence stay explicitly unverified; a successful command does not prove that a running session loaded the changes. Subagents are verified against the current desired content. Verification continues in the background beyond 35 seconds, reconnects after interrupted polling and resumes when the page reopens.
- Drift handling: models offer adopt-current, reapply-desired or pause model management for that Bot; writes carry the reviewed configuration summary and re-read before applying, keeping the current state on mismatch.

### Tasks and recovery

- A task center groups status, failure category (temporary, permission, conflict, unsupported, corrupt, unconfirmed), attempt count and earliest retry time by Bot and resource, with per-item retry, pause and resume. Temporary failures retry with backoff; the rest wait for manual action.
- Commands run in their own process group: timeouts, cancellation and output limits end the whole tree. Mutations with a lost response are read back before reconciliation.
- Before creating an MCP connector or skill for the first time, the plugin persists recovery intent: after a lost response, ownership is restored only when identity and complete content read back identically.

### Drafts and bulk actions

- Unfinished settings and plan drafts autosave completely through the authenticated local service and are restored against the same settings baseline. Concurrent edits across pages prompt to restore the latest draft instead of silently overwriting; a corrupt draft keeps the original file with guidance.
- Plan drafts retain model and resource assignment modes; hidden input values do not change the selected mode. Legacy drafts infer missing modes from saved plans. Previously lost editing intent cannot be fully recovered, so review the preview after restoring an old draft.
- Draft locks recover ownership from processes confirmed to have exited and preserve live owners. Anonymous legacy locks or unverified ownership are never deleted automatically. If prompted, stop all plugin hosts, back up and move `page-draft.lock` and `page-draft-locks` out of the state directory, then reopen the page. Keep `page-draft.json`.
- Bulk copy stages the source Bot's effective configuration, including inherited plans, into the draft; the latest bulk change can be undone. Account permissions are excluded from bulk copy.

### Backups and rollback

- **Backup and restore** centralizes management-record backups and configuration checkpoints: create backups, open the backup folder, import external files (8 MiB limit; record imports need a complete v1/v2 snapshot, checkpoint imports accept version 1 records), JSON export and per-collection clearing. Backups support names, notes and retention flags; retained items survive automatic pruning, bulk clearing and local-record cleanup.
- A configuration checkpoint is created before each save (file mode 0600, latest 20 unretained kept). Checkpoints roll back selectively by field and Bot, automatically including related plan definitions, inheritance and scope changes; restores stage a draft for preview before saving.
- Restoring a management-record backup pauses automatic sync until previewed and manually continued; restarting the host does not clear the pause.
- Restore preflight failures do not introduce a new pause. Failures after the state-writing stage begins retain the pause until the result can be reviewed.
- **Clean up local records** previews counts and sizes before confirming: it removes completed operation history (up to 500 records), old state backups (latest 5 unretained kept) and skill caches unused for over 7 days, and compacts the journal. Current ownership, permission-recovery data, unfinished operations and skills in use are retained.


## Page and assignments

- **Sync settings**: switches for the model connection, models, connectors, skills, instructions and subagents. Disconnect handling and the three resource scopes use switches: off means global sync, on means per-Bot assignment.
- **Bot resources**: three independent scopes for models, connectors and skills; all Bots are listed automatically (names and IDs are read-only; refresh the list). Supports search by name/ID, status filters and unsaved-change counts.
- **Sync status**: generates a live report on demand, showing the viewing time and the last synchronization time, with explicit stale and in-progress states. Viewing never triggers sync; retry synchronization separately. Shows the current step and its duration, CLI and merged-read counts, and the last 20 in-memory rounds (cleared on restart); issues link straight to the relevant settings area.

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


## Source layout

- `bridge.mjs`: plugin entry point.
- `ducoro.agent.js`: Magpie agent definition.
- `diagnostics-cli.mjs`: diagnostic command entry point.
- `lib/`: internal synchronization, state, diagnostics and page service modules.
- `ui/` and `assets/`: web page files and icons.
- `scripts/`: maintenance commands.
- `docs/`: changelog and release notes.

## License

MIT
