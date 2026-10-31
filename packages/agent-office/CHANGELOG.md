# Changelog

## 0.2.0 · 2026-10-31

功能对齐 [whatsmyagentdoing](https://github.com/Charonyuu/whatsmyagentdoing)，并加入真正的 3D 与独立运行方式。

### Added

- Real WebGL 3D office (`page/scene3d.js`, bundled three.js r169): orthographic orbit camera, wheel zoom, lighting, shadows, six procedural scenes (office, station, cafe, castle, pirate, graveyard), animated workers and DOM name-tag anchors.
- ISO canvas view between 2D and 3D: five activity venues (reading, arcade, huddle, ping-pong, coffee), an office cat, day/night window light, drag-pan and wheel/pinch zoom.
- Copilot CLI, Kimi Code and Grok Build readers, Claude Code subagents, OMP profiles, and parent/subagent metadata.
- Workbench: Needs you → Working → Finished groups, agent-mix / subagent / idle filters, grouped side rail.
- Today panel: turns, tokens, top folders and context bars (60% warn, 85% full).
- Recent conversation in the agent panel (last 8 messages), with privacy redaction.
- No-progress badges at 8 minutes thinking and 10 minutes running; completed agents wander the venues and sofa.
- In-page toast for new waiting/error sessions; tab-title need-you count.
- Claude process-liveness check: a session mid-turn with no live process (for example `claude -p` killed from another agent) is **stopped**, not stuck.
- **Clear** removes a finished/stopped/waiting/stuck agent until its session moves again.
- Nine-language UI: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, with prompt-script, theme and browser fallback.
- Standalone `bin/agent-office.mjs` (`--json`, `--private`, `--hours`, local page server) and `SKILL.md` for Claude Code / Codex skills.

### Fixed

- Follow-up after PR #551 approval/merge: skip per-character framing for complete image-heavy records during initial/reset scans; frame only new fragments of the unfinished EOF record.
- Cover identical-witness inode replacement, invalidated committed EOF records, exact Codex-title append reads and unchanged summary caching with independently mutation-checked regressions.
- Narrow the CSP compatibility note to the reproduced Mac Playwright/WebKit build and add a local diagnostic; Linux build 2336 did not reproduce the refusal.

- Secure the standalone server with per-run capability URLs, validated Host and same-origin JSON writes; reject cross-site data/script access.
- Scrub hidden rail, list, conversation and closed-panel DOM when text is disabled.
- Keep stopped 3D renderers stopped across visibility and context restoration; avoid hidden-canvas DPR growth.
- Execute bundled THREE in renderer tests; batch articulated worker meshes with InstancedMesh, preserve crowd capacity and keep six-scene props clear of seating routes.
- Refresh Today usage at local midnight and read Grok's vendor-documented usage sidecar. JSONL now retains per-file byte cursors and reader state; normal polls parse only appended records instead of replaying growing history every 1.5 s.
- Handle partial UTF-8/JSON writes and delayed newlines, reset on truncation/inode replacement/same-size rewrites, and check at most 128 old bytes for truncate-and-regrow. Codex titles use the same incremental framing; unchanged sidecars are not re-parsed or retained as full usage snapshots.
- Preserve incremental tool/stream/usage state, Claude response corrections and metadata removal/fallback precedence; incomplete quoted braces do not trigger repeated full-record parsing. Byte-count regression tests cover 100 MiB logs and fragmented image/text writes.
- Recompute time-based states without new log writes; allow clearing No progress sessions, unify rail/list labels and retain alert history across filters.
- Bound menus and panels to the current CSS viewport; fingerprint static assets to prevent mixing old resources after a same-version update.
- Translate scene/quality/fallback/venue labels and scope camera shortcuts to a focused canvas.

- Inactive canvas is hidden explicitly, so switching between 3D, ISO and 2D never leaves the previous renderer visible.
- The grouped rail and menus no longer sit under the agent detail panel.
- The security test distinguishes the vendored three.js bundle from our own page code; `scene3d.js` still has no network calls.
- Toolbar controls are grouped, so Settings never wraps alone on a second row.
- The page fills the plugin frame without an outer scrollbar; the stage shrinks instead of overflowing.
- Name tags use their laid-out position for collision stacking, stay inside the stage, and are capped by priority so they cannot cover the office.
- The grouped side rail now defaults to **closed** (previous default: open), leaving more space for the office. Open it with **Panel**; an old saved `side:true` is ignored once unless it carries the current preference version.

## 0.1.0 · 2026-10-29

首个公开发布版本。First public release.

### Added

- Live session readers for Claude Code, Codex, DeepSeek Harness, Gemini CLI, Qwen Code, Pi, omp, Qoder, WorkBuddy and CodeBuddy, with a gateway-hook fallback for other agents.
- Isometric 3D and top-down 2D office, live list, per-agent details and resume commands, plus a draggable and resizable in-page floating window.
- Real-time statuses, current tool steps, approval requests, completed and failed sessions.
- Varied idle gestures: stretching, glancing, leg swinging and dozing, with reduced-motion support.
- Front-aisle sofa boarding and exit, collision-safe pathfinding, worker separation and non-overlapping name tags.
- Correct seating orientation, monitor screens, chair backs and sitting legs for every seat.
- Real agent icons for the agents magpie knows, English and Chinese UI, and local-only text privacy controls.
- Furniture and seated-worker compositing, with no workers painted through sofas, cushions, backrests or consoles.
- The page follows magpie's window background without an outer grey ring.
- 44 automated tests covering session parsing, package safety, pathfinding, sofa compositing, orientation and idle gestures.
