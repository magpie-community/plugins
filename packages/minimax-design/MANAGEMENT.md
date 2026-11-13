# Design management scope

Checked against the installed domestic production Design 4.0.10 and Magpie
0.1.4040 source on November 13, 2026.

| Capability | Current management | Boundary |
| --- | --- | --- |
| Text models | Magpie Agent connection, catalogue refresh and disconnect restoration | Design chooses the active model; invalid IDs/limits are omitted |
| Image/video models | Companion discovers, synchronizes and removes its native media entries | Enabled switches and unrelated models are preserved; new options require an established gateway mapping |
| Media parameters | Explicit metadata, public OpenRouter schemas and verified route profiles | Defaults are automatic; unknown parameter contracts retain optional manual controls |
| Skills | Library distributes and withdraws user skill files | Design keeps its skill permission toggle |
| MCP servers | Library configuration is projected into Design V3's native connector proxy per workspace | Restart once to load the bridge; later changes sync automatically. The encrypted connector vault is not modified |
| Usage and routing | Requests use the Design agent gateway key | Accounting and provider routing remain Magpie's responsibility; Design's own account credits are separate |
| Project Agent rules | Design manages `<project>/.hilo/project-rules.md` | No global instruction file has been established for Library |
| Memory | Design manages project `.hilo/memory` and user `~/.hub/memory` | User path can be overridden by `HUB_MEMORY_DIR`; these are mutable Design records, not Library instructions |
| Speech | Magpie speech endpoints and the verified Ming route | All requests use Magpie; reference-audio and cloning routes remain excluded |
| Music | Design has native `music` custom model type | Streaming chat music requires a separate adapter |
| ComfyUI/local models/assets/account settings | Design's own managers | No Magpie Library target or verified synchronization contract in this plugin |

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

The cross-platform package requires the companion `magpie.platform` host
change. The locally installed package uses a static macOS platform binding
with stock Magpie. PR #1096 stays Draft while that host prerequisite and
desktop acceptance remain open. Windows paths have regression coverage, but
there is no new native Windows execution result.
