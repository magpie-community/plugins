# Design management scope

Checked against the installed domestic production Design 4.0.10 and Magpie
0.1.4040 source on November 13, 2026.

| Capability | Current management | Boundary |
| --- | --- | --- |
| Text models | Magpie Agent connection, catalogue refresh and disconnect restoration | Design chooses the active model; invalid IDs/limits are omitted |
| Image/video models | Companion discovers, synchronizes and removes its native media entries | Enabled switches and unrelated models are preserved; new options require an established gateway mapping |
| Media parameters | Explicit metadata, public OpenRouter schemas and verified route profiles | Defaults are automatic; unknown parameter contracts retain optional manual controls |
| Skills | Library staging is projected into the native user skill directory | Local metadata supplies summary/version without changing shared sources; Design keeps its permission toggle |
| MCP servers | Library staging is saved into Design's encrypted native vault before startup | Design manages saved-list visibility and runtime connection; changes wait while Design runs |
| Usage and routing | Requests use the Design agent gateway key | Accounting and provider routing remain Magpie's responsibility; Design's own account credits are separate |
| Project Agent rules | Design manages `<project>/.hilo/project-rules.md` | No global instruction file has been established for Library |
| Memory | Design manages project `.hilo/memory` and user `~/.hub/memory` | User path can be overridden by `HUB_MEMORY_DIR`; these are mutable Design records, not Library instructions |
| Speech | Magpie speech endpoints and the verified Ming route | All requests use Magpie; reference-audio and cloning routes remain excluded |
| Music | Design has native `music` custom model type | Streaming chat music requires a separate adapter |
| ComfyUI/local models/assets/account settings | Design's own managers | No Magpie Library target or verified synchronization contract in this plugin |

## Skill display and MCP management

### Configuration locations

Library writes MCP definitions under `mcp` in
`~/.minimax-design/library-mcp.json`. With Design stopped, `mcp-store.mjs`
converts them to the native saved-server schema and encrypts `customMcpVault`
in `hub-config.json` using the existing local `.token-key`. The original
configuration is backed up before the first write. On macOS this shared
directory points to `~/Library/Application Support/@hilo/desktop`.

Design's `CustomMcpMainService` loads these records and owns runtime
connection and saved-list state. The old connector-only bridge could make
tools callable without a saved desktop record, producing “plugin missing”
cards even after successful calls. Migration removes identical Library
entries from `ai-runtime/config-home/opencode/opencode.json` and removes
this installation's bridge, preserving unrelated runtime entries/plugins.
The runtime plugin stops registering only after the ownership record marks
native persistence and old-bridge cleanup complete. A staging file alone does
not disable it. Cleanup failures retain a pending migration state and retry
after Design exits. Skill, MCP and media failures are reported independently,
so a Library conflict does not prevent unrelated media refresh.
Same-name legacy runtime definitions with different fields block migration
completion and remain untouched. Object key order alone is not a conflict.
Executable/URL whitespace and environment/header key whitespace are normalized
before native storage and ownership comparison, matching Design's handling of
these fields; genuine local configuration edits still block replacement.

The ownership receipt also keeps the last staged runtime definitions, so
switching from direct servers to a router can clean matching old entries.
Each name retains exact candidates for the Library definition and Design's
native runtime projection, including native enabled/timeout fields. A
same-name update retains both prior and current candidates until cleanup
succeeds; changed runtime fields that match neither remain conflicts.
A ready receipt does not bypass checking for a restored runtime bridge.
For installations predating these receipts, `syncMcpStore` accepts
`legacyManaged` definitions recovered from verified prior Library application
records and a matching runtime snapshot. It does not infer ownership from
a server's name or endpoint.

Discovery defaults to 60 seconds unless Library provides an explicit timeout.
This covers Magpie's 40-second hub listing budget; Design's default 30-second
proxy request could connect successfully yet fail a later `tools/list`.

Vault changes wait while Design runs. Existing services are not adopted
silently; name conflicts and local config edits stop the sync. Native
enabled switches survive refresh unless Library changes its enabled state.
Withdrawal removes only owned records and associated side data.

Skills stage in `~/.minimax-design/library-skills`. Each native directory
in `~/Movies/Hub/skills` contains links to the original files plus a local
`meta.yaml` and ownership marker. YAML frontmatter provides description and
version; existing source metadata takes precedence. Structured detail fields
are copied when supplied, never invented. Shared source files are untouched.
An existing matching Library directory link can migrate; user-owned directories
and locally edited projections stop the sync rather than being overwritten.

On November 14, 2026, isolated acceptance used Design 4.0.10's actual
decryption, validation and saved-service implementation to verify encrypted
records, saved-list visibility, native toggle persistence across reload,
and withdrawal. A real Magpie sandbox also verified staging, source-preserving
Skill summary/version display and a model → MCP → model turn. These checks
do not establish that a running user's desktop has already migrated.

## Why rules and memory are not synchronized

Design's `ProjectRulesController` requires a locked V3 workspace. Rules have
a 16,384-byte limit, revision checks and a write lock. They are specific to a
project; pointing Library's one global `instructions` path at an arbitrary
project would give the wrong scope. The runtime also disables ordinary
OpenCode project configuration and Claude Code discovery.

Memory has separate user/project scopes, its own validation and write locks.
The user scope defaults to `hubRoot()/memory`, which is `~/.hub/memory` for
the tested domestic production profile. It is not an established always-read
global instruction document. The plugin does not overwrite or turn these
directories into skill/instruction targets.

A future rules bridge needs an explicit project target and revision-aware
updates. Memory management needs its own lifecycle and merge contract.
Neither can be promised merely by adding another path to the agent descriptor.

## Speech and music

The installed Design runtime declares
`MEDIA_MODEL_TYPES = ["image", "video", "speech", "music"]`.
The examined Magpie gateway supports `POST /v1/audio/speech`, but its current
model-discovery extensions supply explicit `kind` values only for images,
videos and decisions. Its speech handler relays OpenAI-style fields and the
vendor response; this does not establish compatibility with every MiniMax
native speech/music interface.

Speech uses explicitly advertised endpoints and the verified Ming route.
Parameter schemas provide voice, format, speed and instruction controls.
All speech requests use Magpie's gateway. The uninstalled direct-LoomVox
experiment was withdrawn; it is not part of this release.
There is no verified common music-generation endpoint in the examined gateway.
Audio output modality alone cannot distinguish speech, music and sound effects;
Lyria streaming chat audio remains outside this release.

## Acceptance and release

Node and Bun each pass 24 regression tests. Design's actual packaged media
loader, spec parser, adapter sandbox and executor pass isolated image/video
fixture tests. Text/Skill/MCP native acceptance runs separately with local
fixtures; these checks incur no vendor inference.

The live desktop model-access settings display the 29 synchronized media
models, with enabled switches and generated Hailuo presets. The current
workspace reports an interrupted task and disconnected network; canvas
generation selection, real vendor inference and canvas output insertion
remain unaccepted. A prior quit attempt warned about interrupting tasks and
was cancelled. Restart needs user confirmation.

The cross-platform Agent uses a shared `~/.minimax-design` directory entry,
prepared by the existing companion. Stock Magpie loads it without platform
globals or a modified host. Native acceptance covers connection, Library,
inference and restoration on macOS. Windows paths have regression coverage,
but there is no native Windows junction execution result.
