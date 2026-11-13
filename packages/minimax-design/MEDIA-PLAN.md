# Native media model integration

Target: MiniMax Design 4.0.10 domestic production on macOS. The existing
Agent switch also owns a Magpie provider in Design's native media store.

1. Read the connected agent's gateway address and agent key. Discover media
   models from `/v1/models` with `X-Magpie-Drawers: 1` and
   `X-Magpie-Videomakers: 1`; use explicit `kind`, never model-name guesses.
2. Add a companion Bun plugin, following the repository's existing agent
   bridge pattern. Refresh on connection/catalog changes and periodically.
   Failed discovery preserves the last successful list.
3. Incrementally manage `media-models/config.json` and owned model directories.
   Use Design's store lock convention, private atomic writes, stable IDs and
   a durable ownership record. Preserve unrelated models/providers. Disconnect
   removes only owned entries. Refuse unsupported store versions/collisions.
4. Provide Design-native image and video adapters. Images use generation or
   editing and return files; videos submit, poll, and fetch authenticated
   content. Credentials remain in provider headers, never adapter sources.
5. Show only gateway-supported common controls. The catalogue does not
   enumerate per-model parameter ranges, so do not invent vendor presets.
   Initial scope: text-to-image, image editing where declared, text-to-video
   and one first-frame image. Additional video/audio references await explicit
   capability metadata.
6. Test adapter behavior, catalogue sync/update/removal, failed discovery,
   lock contention, preserved user data and disconnect. Validate generated
   stores and adapters with the installed Design runtime in disposable homes,
   including image/video fixture output. No paid inference.
7. Install the tested companion locally and confirm native model discovery.
   Keep the PR Draft until the host platform prerequisite and any remaining
   desktop acceptance requirements are satisfied.

## Implementation status

Steps 1–6 are implemented with fixture-based native runtime validation.
The local companion is installed and has synchronized 22 image and 7 video
models. Node/Bun regression tests pass. Desktop UI still showed the prior
list; exiting Design warned that tasks would be interrupted and was
cancelled. Step 7 remains incomplete for desktop selection and canvas
insertion. No paid generation was submitted.
