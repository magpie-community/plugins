<p align="center">
  <img src="docs/assets/hero-banner.svg" alt="Herdr Lock Screen Detach — Headless macOS Magpie Plugin" width="100%" />
</p>

<h1 align="center">Herdr Lock Screen Detach (<code>magpie-herdr-lock-screen-detach</code>)</h1>

<p align="center">
  <strong>Walk away and lock your Mac — your local Herdr TUI detaches cleanly while servers, agents, and remote sessions keep running.</strong><br />
  离开工位锁屏或合盖休眠时，自动优雅断开本机 GUI 终端里的 Herdr 客户端；后台服务、运行中的 Agent 与手机/SSH 远端连接毫发无损。
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-34d399.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20(no--op%20elsewhere)-38bdf8.svg" alt="macOS" />
  <img src="https://img.shields.io/badge/runtime-Node.js%20%E2%89%A520%20%7C%20Bun-6366f1.svg" alt="Node.js >= 20 or Bun" />
  <img src="https://img.shields.io/badge/dependencies-0-10b981.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/idle%20CPU-0.0%25-f59e0b.svg" alt="Zero Idle CPU" />
</p>

<p align="center">
  <a href="#why-this-exists">Why</a> ·
  <a href="#architecture--reload-safety">Architecture</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#options">Options</a> ·
  <a href="#security--safety-model">Security</a> ·
  <a href="#quickstart-3-minute-verification">Quickstart</a>
</p>

---

## Why This Exists

Leave a local `herdr` TUI attached in Ghostty / iTerm2 / Terminal.app, lock your Mac, and connect later from your phone or another laptop — Herdr either clamps viewport size to the forgotten local window or holds an extra client attached.

**Herdr Lock Screen Detach** fixes that exact workflow with **zero changes to Herdr** and **zero separate LaunchAgents**:

- **Headless Magpie plugin**: no sidebar tab, no open HTTP ports, no `auth` hook, zero outbound network calls.
- **Pure `Foundation` + `IOKit` native watcher**: no `AppKit` or WindowServer connection (~2–6 MB RSS, **0.0% idle CPU**).
- **Surgical `SIGTERM` detach**: on macOS **Lock Screen** (`com.apple.screenIsLocked`) or **System Sleep** (`kIOMessageSystemWillSleep`), sends `SIGTERM` **only** to interactive local GUI `herdr` TUI clients. Herdr traps `SIGTERM`, sends `ClientMessage::Detach`, restores the terminal cleanly, and exits `0`. Next time you unlock, just run `herdr` to reattach.
- **Cross-platform safe**: silently no-ops on Linux and Windows so a single shared `plugins.json` works across all machines.

---

## Architecture & Reload Safety

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Herdr Lock Screen Detach architecture and reload-safe handover" width="100%" />
</p>

Magpie's shared Bun plugin host (`host.js`) overlaps old and new hosts during hot-reload and may hard-kill (`SIGKILL`) a retiring host after 2 seconds. Every timing edge case is handled explicitly:

| Race / Failure Mode | Protection Mechanism |
|---|---|
| **Non-blocking Magpie boot** | `server()` returns `{}` in <1ms; first-time `swiftc` compilation runs asynchronously under an exclusive `0700` `mkdir` build lock and aborts cleanly if Magpie reloads mid-build. |
| **Overlapping hot-reload hosts** | Single-instance BSD `flock(LOCK_EX \| LOCK_NB)` on `watcher.lock`. Contenders exit with code `75` (`EX_TEMPFAIL`); the supervisor treats `75` as normal handover (retrying every `400ms`, zero crash backoff). |
| **Fast graceful handover** | Hooks `process.stdin` `end`/`close` (fired the instant Magpie closes old host stdin), releasing `flock` within milliseconds — and **never** installs `SIGTERM`/`SIGINT` handlers on `host.js` so shared host termination signals are never swallowed. |
| **Hard `SIGKILL` of Magpie host** | Native watcher runs with `--watch-parent`, combining **stdin pipe EOF** (`DispatchSource.makeReadSource`) and **`kqueue` `EVFILT_PROC NOTE_EXIT`**. Kernel tears down both in <5ms — **zero orphan processes**. |
| **Concurrent upgrades** | Content-addressed binary name (`herdr-lock-screen-detach-<arch>-<sha12>`) + atomic temp `rename()` + 5-minute grace window before pruning older hashes. |
| **Sleep stall prevention** | Responds to `kIOMessageCanSystemSleep` immediately and guarantees `IOAllowPowerChange()` via `defer` on `kIOMessageSystemWillSleep`. |

---

## Installation

### Requirements

- **macOS** with Apple Command Line Tools (`swiftc`, via `xcode-select --install`)
- **Magpie** (Node >= 20 / Bun plugin host)
- **Herdr** (optional at install time; watcher logs zero matches when no local TUI is attached)

### Register in Magpie (`plugins.json`)

```json
{
  "name": "Herdr Lock Screen Detach",
  "spec": "/path/to/magpie-herdr-lock-screen-detach",
  "options": {
    "enabled": true,
    "dryRun": false,
    "watchSleep": true,
    "debounceMs": 1500
  }
}
```

Or install directly from GitHub via Magpie CLI:

```bash
magpie plugin add github:<owner>/magpie-herdr-lock-screen-detach
```

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Disable watcher without removing the plugin entry. |
| `dryRun` | `boolean` | `false` | Log matched local GUI `herdr` clients on Lock Screen / sleep without sending `SIGTERM`. |
| `watchSleep` | `boolean` | `true` | Observe `IOKit` `kIOMessageSystemWillSleep` in addition to `com.apple.screenIsLocked`. |
| `debounceMs` | `number` | `1500` | Deduplicate simultaneous Lock Screen + sleep events within this window. |
| `stateDir` | `string` | `~/.cache/magpie-herdr-lock-screen-detach` | `0700` directory storing the content-addressed binary and `watcher.lock`. |
| `handoverRetryMs` | `number` | `400` | Retry interval when taking over `watcher.lock` during Magpie hot-reload. |

---

## Security & Safety Model

Before sending `SIGTERM` to any PID, the native watcher enforces five invariants:

1. **Current UID only** — only queries processes owned by `getuid()`, then re-verifies `pbi_uid == getuid()` via `proc_pidinfo(PROC_PIDTBSDINFO)` microseconds before signaling.
2. **Kernel executable path check (`proc_pidpath`)** — confirms the real vnode executable basename is exact `"herdr"` right before `kill()`, defeating `argv[0]` spoofing and PID-reuse TOCTOU races.
3. **Interactive TUI invocations only** — matches `herdr` (including global flags such as `--session`, `--socket`, `--config`, `--remote`, `--remote-keybindings`, `--machine`, `--host`, `--target`) and `herdr session attach ...`; strictly excludes `herdr server`, `remote-client-bridge`, `agent`, `pane`, `api`, `plugin`, `status`, `--version`, `--help`, and `Herdr.app`.
4. **Local GUI TTY only** — requires a live kernel controlling TTY (`e_tdev != -1 && e_tdev != 0`) and rejects any process descending from `sshd`, `sshd-session`, `sshd-keygen-wrapper`, or `mosh-server`.
5. **Symlink-safe state** — state directory is created with `0700` permissions and `watcher.lock` is opened with `O_NOFOLLOW | O_CLOEXEC` (`0600`).

> **Edge case note (`tmux` / `screen`)**: If you run a `herdr` TUI client inside a long-lived `tmux` server originally started from your local GUI session and later attach to that `tmux` over SSH, `herdr`'s process ancestor is `tmux` (not `sshd`), so it will be treated as a local client on Lock Screen. Direct SSH/Mosh sessions into the Mac are always preserved.

---

## Quickstart: 3-Minute Verification

```bash
# 1. Run full verification suite (lint, supervisor unit tests, sanitization guardrails,
#    macOS native compile + zero-AppKit check + O_NOFOLLOW symlink guard + flock handover
#    + SIGKILL orphan test + overlapping reload test + docs/SVG validation)
make check

# 2. Preview which local GUI Herdr clients would be detached right now (read-only)
make dry-run

# 3. Inspect standalone CLI status
node lib/cli.mjs status
```

---

## Repository Layout

```text
magpie-herdr-lock-screen-detach/
├── index.mjs                           # Headless Magpie plugin entry (`id`, non-blocking `server`)
├── lib/
│   ├── supervisor.mjs                  # Content-addressed builder, handover, backoff & lifecycle
│   └── cli.mjs                         # Standalone CLI (status, build, dry-run, run-once, self-test)
├── native/
│   └── herdr_lock_screen_detach.swift  # Pure Foundation + IOKit watcher (zero AppKit)
├── docs/assets/
│   ├── hero-banner.svg                 # Dark-mode hero banner
│   └── architecture.svg                # Architecture & reload-safety diagram
└── test/
    ├── supervisor.test.mjs             # Cross-platform reload, abort, signal-safety & non-darwin tests
    ├── native.test.mjs                 # macOS compile, zero-AppKit, O_NOFOLLOW, flock & SIGKILL tests
    └── sanitization.test.mjs           # Open-source sanitization & binary allowlist guardrails
```

---

## License

MIT — see [LICENSE](./LICENSE). Contributions welcome via [CONTRIBUTING.md](./CONTRIBUTING.md).
