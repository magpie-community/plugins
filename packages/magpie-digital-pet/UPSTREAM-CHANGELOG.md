# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0] - 2026-10-29

### Changed

- feat: add LCD and Color themes with web integration


## [0.17.0] - 2026-10-29

### Changed

- Feat/multiplayer product design


## [0.16.0] - 2026-10-21

- Repair DoneDevimon's identity, missing LoaderLeomon/Crowmon branches and eight pair-only routes without adding species or changing saved IDs.
- Count duplicate DORUguremon IDs once in automatic evolution selection, preserve legacy pending duels, and let final forms keep earning EXP and fighting threshold duels.

### Changed

- Adapt device evolution victory minimums to game pacing (12→3, 24→5, 50→7, 200→10) in shared rules and the Dex, preserving care alternatives and existing counters.
- Use locally bundled, species-specific projectiles in shared battles: all 109 PENOG sprites and reviewed assignments for 526 catalog entries; retain the existing fallback where source data is missing.

## [0.15.1] - 2026-10-15

### Changed

- Restore Lopmon and other omitted evolution branches from reviewed device detail cards, keep fusion/special routes out of ordinary EXP selection and preserve withdrawn targets for pending saves.
- Give each companion its own adventure cooldown, preserve the principal's legacy timer and keep adventure waits advancing in reserve while apple and care timers pause.

## [0.15.0] - 2026-10-14

### Changed

- Start the evolution duel at 100% even without an eligible route. Count a win before choosing the target; without a result, retain the companion and victory, show the notice and reset EXP.
- Persist adventure and evolution-duel victories per form, prevent replayed rewards and show numeric Dex requirements only on applicable routes.
- Prepare shared SQLite team persistence for two owned companions, preserving the existing active pet during migration and keeping token receipts on the principal. Team controls are not exposed yet.
- Choose experience evolutions from referenced normal routes according to the current 0–3 unclean piles. Exclude Jogress and unverified routes from automatic evolution.

## [0.14.0] - 2026-10-11

### Changed

- Feat/music loop sections


## [0.13.0] - 2026-10-11

### Changed

- Feat/adventure pixel controls


## [0.12.0] - 2026-10-11

### Changed

- feat: add adventure bosses and refine pet care UI


## [0.11.0] - 2026-10-11

### Changed

- feat: add persistent adventures and companion recruitment


## [0.10.0] - 2026-10-11

### Changed

- feat: add pet affection, scale battle rewards and refine Dex UI


## [0.9.0] - 2026-10-10

### Changed

- feat: add egg petting rewards in web and Cursor


## [0.8.0] - 2026-10-10

### Changed

- feat: add shared translations and persistent web language selection


## [0.7.0] - 2026-10-10

### Changed

- feat: add player battles and shared pet care


## [0.6.0] - 2026-10-09

### Changed

- Feat/gameplay combat evolution feeding


## [0.5.0] - 2026-10-07

### Changed

- feat(web): version and tag site releases like the other products


## [0.4.0] - 2026-10-07

### Changed

- feat(ci): dispatch web deploy from merged release plan


## [0.3.0] - 2026-10-06

### Changed

- Feat/cursor pet display


## [0.2.3] - 2026-10-06

### Changed

- chore(digital-pet-core): mark stages for a release probe


## [0.2.2] - 2026-10-06

### Changed

- fix(cursor-digital-pet): point README images at the package directory


## [0.2.1] - 2026-10-06

### Changed

- fix(cursor-digital-pet): point README images at the package directory


## [0.2.0] - 2026-10-06

### Changed

- Renamed the product and packages to Digital Pet under the `jcendal` namespace.
- Kept existing `opencode-vpet` settings and database paths readable so current partners remain available.
- Updated release metadata for the `jcendal/digital-pet` repository and credited Sergio Bugallo as the original author.

## [0.1.1] - 2026-08-30

### Fixed

- Exported the OpenCode server plugin entrypoint so VPet commands and the sidebar load correctly.
- Updated `init` and `update` to delegate to OpenCode's native global plugin installer with the
  installed exact package version, avoiding stale bare or `@latest` cache reuse.

## [0.1.0] - 2026-08-30

### Added

- Server and TUI plugins that add a Digimon virtual pet to the OpenCode sidebar.
- Progression from completed assistant-message token usage, including reconciliation of completed 
  usage from concurrent sessions.
- Toast notifications for spawning, progression controls, and Digimon evolutions.
- A 650-Digimon catalog spanning eight evolution stages, with evolution paths and Japanese and 
  English names.
- Partner generations that can be spawned, evolved, frozen, unfrozen, or set to a catalog ID.
- Sidebar progress and status display, including frozen and manually set partner states, with 
  animated walking, action, and sleep behavior.
- Dex and History dialogs for browsing discovered Digimon and current or retired partner 
  generations, with links to external encyclopedia entries.
- `/vpet-spawn`, `/vpet-freeze`, `/vpet-unfreeze`, `/vpet-set <id>`, `/vpet-dex`, and 
  `/vpet-history` commands.
- SQLite persistence for partners, progression events, usage receipts, trainer totals, and control 
  state.
- Global settings for language, evolution thresholds, and notifications.
- `npx @sbugallo/opencode-vpet init` and `npx @sbugallo/opencode-vpet update` commands that register 
  server and TUI plugins while preserving unrelated JSON and JSONC configuration.
