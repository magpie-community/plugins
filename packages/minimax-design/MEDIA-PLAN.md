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
5. Automatically project explicit gateway parameter metadata first, public
   OpenRouter endpoint schemas second, and verified exact-route profiles
   otherwise. Map only parameters that the gateway can transport faithfully.
   Use automatic defaults, legal combination presets and adapter preflight.
   Additional video/audio references await explicit capability metadata.
6. Test adapter behavior, catalogue sync/update/removal, failed discovery,
   lock contention, preserved user data and disconnect. Validate generated
   stores and adapters with the installed Design runtime in disposable homes,
   including image/video fixture output. No paid inference.
7. Install the tested companion locally and confirm native model discovery.
   Keep the PR Draft until remaining desktop acceptance requirements are
   satisfied. The shared directory entry removes the host platform prerequisite.

## Implementation status

Steps 1–6 are implemented with fixture-based native runtime validation.
The local companion is installed and has synchronized 22 image and 7 video
models. Node/Bun regression tests pass. The model-access settings now display
the synchronized catalogue and generated Hailuo presets; canvas selection
remains unaccepted. Exiting Design warned that tasks would be interrupted
and was cancelled. Version 0.3.1 adds parameter profiles, live OpenRouter schema
discovery, multi-image budgets and preflight, verified with generated adapters
inside Design's real runtime. Step 7 remains incomplete for desktop selection and canvas
insertion. No paid generation was submitted.
Version 0.3.2 corrects ineffective OpenRouter resolution controls and video
reference budgets that exceeded the adapter's verified modes. MANAGEMENT.md
records the management audit and release boundaries.
