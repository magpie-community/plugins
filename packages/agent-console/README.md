# Agent Console

A Magpie page plugin that drives real local Agent CLIs (Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin, dsh). Each conversation is a **persistent Agent session** on a standalone Node daemon. Close or refresh the page — the Agent keeps running while Magpie is open. Reopen the page and you pick up where you left off. When Magpie quits, the daemon and its Agents stop; threads are persisted and can be resumed next time.

## Install

Requires [Magpie](https://usemagpie.ai) ≥ 0.1.1340 and Node.js ≥ 20.

```bash
magpie plugin add @magpie-community/page-agent-console
```

Or in Magpie: **Settings → Plugins → Add plugin**, enter `@magpie-community/page-agent-console` (or find **Agent Console** in Discover). After install, **Agent Console** appears in the sidebar plugin group.

Install the Agent CLIs you want to use (for example `claude` or `codex`). Missing CLIs show an install hint in Settings.

---

This is not a gateway chat box. The daemon talks to the real CLIs through `@anthropic-ai/claude-agent-sdk`, `codex app-server`, and ACP, normalizes a structured event stream (tool calls, thinking, permission requests, usage), and pushes it to the React page over WebSocket.

UI principle: **obvious at a glance, nothing extra**. Three columns — sidebar (projects × threads), conversation timeline, and a right panel (changes / files / terminal).

## Features

- **Persistent sessions**: each thread binds to a long-lived Agent process; after a daemon restart, running threads are marked closed and can be resumed (`--resume` / `thread/resume`)
- **Multiple Agents**: Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin, dsh; missing CLIs show an install hint
- **Model / permission / thinking**: per-thread; four permission modes and five thinking levels (what each Agent actually supports)
- **Structured timeline**: user message → thinking (expandable) → tool calls (read / edit / command, with line-level diffs) → todos → usage and duration; answer permission requests (tools / plan / questions) on the card
- **Steer and queue**: steer while running, queue the next message, interrupt
- **Changes panel**: git status refresh every 3s, unified per-file diffs; discarded untracked files go to trash instead of a hard delete
- **Files panel**: lazy directory tree (respects `.gitignore`), syntax-highlighted preview
- **Terminal panel**: real PTY via node-pty (pwsh / powershell); reconnects after reopening the page; degrades if PTY is unavailable
- **Images**: attach or paste images (and text files). Claude Code and Codex take images natively. An ACP Agent (Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh) gets image blocks when its ACP `initialize` advertises `promptCapabilities.image`; otherwise it gets each image's file path (as text and a `resource_link`), so it can open it with its file tools, and the timeline says it can't see the image itself. The composer says so before you send once the Agent has been asked. Checked on 2026-10-31 with a sandbox HOME and no sign-in: Cursor 2026.10.22, Copilot 1.0.105, OpenCode 1.19.5 and pi-acp 0.0.34 advertise images; dsh 0.2.1-rc.5 does not; Devin CLI wasn't checked. Inline media is capped at 10 MB per file and 16 MB per message (an ACP SDK peer refuses messages over 32 MB); larger images go by path
- **Import history**: import matching sessions from `~/.claude/projects` and `~/.codex/sessions` as new threads (resumable)
- **Thread management**: search (Ctrl+K), pin, rename, archive, delete (trash), export Markdown, thread info (usage / cost / session ID)
- **Mock Agent**: `AGENT_CONSOLE_MOCK=1` registers a demo Agent with 8 scripts (`default` / `perm` / `plan` / `ask` / `slow` / `error` / `long` / `exit`) so UI work does not burn tokens

## Architecture

```
Magpie window
 └─ page/index.html  (sandbox="allow-scripts" iframe, served by Magpie from /_magpie/plugin/<per-run id>/)
     │ reads page/session.js  {port, key}  (gate key only, written by the plugin host)
     │ navigates itself to  http://127.0.0.1:<port>/open?k=<key>&theme=…
     ▼
Magpie plugin host (Bun) ── index.mjs + lib/gate.mjs  "gate" on 127.0.0.1:<port> (default 3488)
     │ first /open: spawns the daemon as a child process (node, --port 0, stdin lifeline, --parent-pid)
     │ 302 → http://127.0.0.1:<daemonPort>/?theme=…#t=<token>
     ▼
daemon (Node, daemon/dist/main.js) ── HTTP + WebSocket on an ephemeral 127.0.0.1 port
     └─ React app (app/) reads the token from location.hash, sends it as the x-agent-console header
        and in the WebSocket hello
```

## Security model

The daemon can run Agents with full access to your machine, so the token that unlocks it must never be readable by another web page.

- **Two secrets per plugin-host run.** Each run generates two independent random 256-bit values: a **gate key** and the **daemon token**. Only the gate key is ever written to a file.
- **Why `session.js` holds only the gate key.** Magpie serves the page folder at `/_magpie/plugin/<per-run id>/`, where the id is an HMAC that changes every time Magpie starts and is handed out only to Magpie's own window. Magpie does not check `Origin`, `Host`, `Sec-Fetch-*` or a cookie on these files, and sends no `Cross-Origin-Resource-Policy`, so the unguessable path is their only protection. A classic `<script src>` include is not subject to CORS, so any page that learned the path (a different localhost port, a `file:` page, any website) could run `session.js` and read `globalThis.AgentConsoleSession`. That is why the file never contains the daemon token.
- **Token handoff.** After the gate binds its port, the host writes `{port, key}` to `page/session.js` (atomic write, mode 0600; git-ignored and excluded from the npm package). The page navigates to the gate's `/open?k=<key>`; the gate compares the key in constant time, starts or reuses the daemon and redirects to it with the daemon token **only in the URL fragment** (`#t=…`). The fragment is never sent to a server, written to a log, or leaked through `Referer`, and the window that ends up holding it belongs to the daemon's origin (an opaque origin inside Magpie's sandboxed frame), so the page that started the navigation cannot read it. A leaked gate key therefore lets another page at most open the console UI in a frame or tab it cannot read; it does not unlock the daemon's API or WebSocket. No HTML served by the daemon contains the token; an unauthenticated `GET /` returns a page with no secret in it.
- **`Origin: null` is not trusted.** Any site can produce `Origin: null` (sandboxed iframes, `data:` and `file:` pages). The token is the only authority:
  - static routes (`/`, `app.js`, …) refuse `Origin: null` and foreign origins with 403 and never send CORS headers;
  - token routes (`/api/*`, `/attachments/*`, WebSocket hello) accept `Origin: null` only as a way to *present* the token (the Magpie iframe has an opaque origin); `access-control-allow-origin: null` is emitted only on responses to requests that carried a valid token, plus the preflight for `/api/upload`; credentials are never allowed;
  - any other origin gets 403 even with a valid token.
- **Host is checked on every request and WebSocket upgrade** (gate and daemon): it must be `127.0.0.1:<port>` or `localhost:<port>` with the actually bound port, otherwise 421. This blocks DNS rebinding, where the attacker's requests carry no `Origin` at all.
- The gate answers only `GET /open?k=<gate key>` (the daemon token is not accepted there), refuses any request that carries an `Origin` header, and sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- WebSocket connections must send `hello` with the token within 5 seconds, otherwise they are closed with code 4401.

## Lifecycle

- Importing `index.mjs` has no side effects (no port, no process, no files).
- `server()` (called by Magpie's plugin host at host start-up — this includes short-lived hosts started by CLI commands such as `magpie plugin add` or `magpie plugin list`) binds the gate and writes `page/session.js`. If the port is busy it retries every 2 s in the background without blocking the host; a detached 0.1.0 daemon still holding the port is shut down once, only after it proves its identity by answering `/api/ping` with the token from `daemon.json`.
- The daemon starts when the page is opened for the first time and is reused for later opens. It is a normal (non-detached) child of the plugin host.
- The daemon exits when its stdin pipe closes or its parent pid disappears (checked every 2 s) — i.e. when Magpie quits or the plugin host restarts — and after 60 minutes idle.
- Magpie's plugin host treats the value returned by `server()` as OpenCode hooks and never calls `stop()`; it exits the Bun process when Magpie closes its stdin. A synchronous `exit` handler therefore closes the daemon's lifeline, signals it, and removes the `session.js` this host wrote. `stop()` (used by tests and other hosts) closes the gate, ends the daemon (graceful, then forced) and removes `session.js`.
- Agents stop with the daemon. Threads are persisted and can be resumed after reopening the page. On macOS/Linux every Agent CLI, the Codex app-server and the no-PTY shell run in their own process group, so stopping one ends everything it started; on Windows the same is done with `taskkill /T`. A process `exit` hook reaps any tree still alive when the daemon exits.

## Platforms

The plugin runs wherever Magpie runs (Windows, macOS, Linux). It needs **Node.js 20+** on `PATH`: Magpie's plugin host is Bun, but the daemon and `node-pty` need Node. If Node is missing, opening the page shows "Node.js was not found" (the gate's 503 page) instead of silently running under Bun; a too-old Node gives a similar message.

- **Finding Agent CLIs.** `PATH` is scanned in JavaScript (no `where.exe`/`which`; `where.exe` prints in the console code page, which garbled Chinese user names). The first hit in `PATH` order wins. Common install dirs are also searched because a GUI app may start with a minimal `PATH` (Magpie adds the login-shell `PATH` itself; this is a fallback): Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), `~/.local/bin`, npm global, Volta, Bun, `~/.claude/local`, `%APPDATA%\npm`.
- **Windows shims.** `.exe` runs directly; npm `.cmd` shims run their `cli.js` with Node; `.ps1`-only shims run with `powershell -NoProfile -ExecutionPolicy Bypass -File`; any other `.cmd`/`.bat` runs through `cmd.exe` with cross-spawn-style escaping (spaces, `&`, `%`, quotes and Chinese in paths and arguments are safe).
- **Terminal.** `node-pty` prebuilds cover win32/darwin/linux × x64/arm64 (Linux prebuilds are glibc only). Default shell: Windows `pwsh` → `powershell` → `cmd`; macOS/Linux `$SHELL` if it exists, else `zsh` (macOS) / `bash` / `sh`. If `node-pty` cannot load, a simple non-PTY terminal is used ([details](#when-node-pty-cant-be-loaded)). On macOS the exec bit of `node-pty`'s `spawn-helper` is restored if the package extraction dropped it.
- **Folder picker.** Windows: PowerShell `FolderBrowserDialog`; macOS: `osascript` "choose folder"; Linux: `zenity` or `kdialog` when a graphical session exists; otherwise type the path.
- **Paths.** Project paths are compared case-insensitively on Windows and macOS (and NFC-normalized on macOS); `realpath.native` resolves 8.3 short names and `subst` drives; UNC paths work. Discarding an untracked file moves it to the trash with a copy fallback when the project and data dir are on different drives.
- **Encoding.** Agent output is decoded as UTF-8; the folder picker falls back to GBK (CP936); the file preview tries UTF-8, then GBK. Git runs with `core.quotepath=false` so Chinese file names show as-is.
- **Magpie desktop window → `http://127.0.0.1`.** Magpie's window origin is `wails://` on macOS/Linux and `http://wails.localhost` on Windows. The plugin frame navigates itself to the gate on `http://127.0.0.1`, as Magpie's plugin-runtime docs describe for page plugins. On macOS, Magpie's `Info.plist` has no ATS keys and ATS exempts IP-address hosts by default, and the main window has no CSP that could block the frame, so the navigation is allowed. This is the one item that still needs a run on a real Mac.
- **Clickjacking / `frame-ancestors`.** Not set on purpose. The UI must load inside Magpie's frame on every mode: `wails://` (a non-special scheme whose origin WebKit may treat as opaque), `http://wails.localhost`, and `magpie web` on any address, LAN IP or reverse proxy. No `frame-ancestors` list covers all of them without breaking one. Framing the console also requires the gate key, which only Magpie's per-run page path hands out.

## Reproducible build

`app/app.js`, `app/app.css`, `app/index.html`, `daemon/dist/main.js` and `daemon/dist/main.js.map` are committed build outputs of `web/src` and `daemon/src` (esbuild, options in `scripts/build-v1.mjs`). They are committed because this repository ships packages as they are checked in: `publish.yml` packs each package onto the `dist` branch with `npm pack --ignore-scripts` (`scripts/dist.mjs`) and publishes it with `npm publish` from its folder, with no install or build step. So the bundles in a pull request are exactly what users get, and `verify:build` proves they are the build of the source next to them.

The build is deterministic: no timestamps, no absolute paths, LF line endings enforced by `.gitattributes`. From this folder (`packages/agent-console`):

```bash
npm ci --workspaces=false              # the repository root is an npm workspace; this installs here, from this folder's package-lock.json
npm run build
git diff --exit-code app daemon/dist   # no output = identical bytes
npm run verify:build                   # rebuilds into a temp dir, byte-compares, prints SHA-256
```

`verify:build` prints `OK <sha256>  <file>` for each bundle and exits non-zero on any mismatch. Without `--workspaces=false`, npm treats this folder as a member of the root workspace and looks for a lockfile at the repository root, which there isn't.

## Dependencies

All dependencies and devDependencies are pinned to exact versions, and `package-lock.json` matches them (`npm ci` succeeds).

- **Installed for users** (`dependencies`): `@agentclientprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `ignore`, `ws`, `zod`. These are what `daemon/dist/main.js` imports (esbuild bundles it with `packages: "external"`, so every package it imports is loaded from `node_modules`); `index.mjs` itself only imports `ws`.
- **Optional** (`optionalDependencies`): `node-pty`, for the terminal panel only (see below).
- **Build only** (`devDependencies`): the UI packages `react`, `react-dom`, `@xterm/xterm`, `@xterm/addon-fit`, `lucide-react`, `marked`, `dompurify`, `highlight.js`, `zustand`, `@tanstack/react-virtual` and `clsx` are bundled into `app/app.js` and never loaded from `node_modules` at run time, plus esbuild, TypeScript, vitest and type packages.
- `@anthropic-ai/claude-agent-sdk` is distributed under Anthropic's commercial terms.

### Why `node-pty` is `1.2.0-beta.15`

Magpie installs a plugin with `bun add` and does not run its dependencies' install scripts (usemagpie.ai/docs/plugins, "Installing"). `node-pty`'s own `install` script (`node scripts/prebuild.js || node-gyp rebuild`) therefore never runs, so the only binary a user gets is the one inside `node-pty`'s npm tarball under `prebuilds/<platform>-<arch>/`.

- `node-pty@1.1.0`, the current `latest`, ships prebuilds for `darwin-x64`, `darwin-arm64`, `win32-x64` and `win32-arm64` only. On Linux it has no binary at all unless `node-gyp` compiles one at install time, which Magpie never does.
- `node-pty@1.2.0-beta.2` and later add `linux-x64` and `linux-arm64` prebuilds (glibc 2.28 or newer). `1.2.0-beta.15` is the beta this plugin is built and tested against, pinned exactly so a later, untested beta is never picked up (`beta.16`–`beta.18` came out on 2026-10-22/23). It also drops winpty, which more than halves the tarball (27 MB unpacked, against 64 MB for 1.1.0).
- The prebuilds are N-API addons, so one binary works on every Node version from 20 up; Node upgrades need no rebuild.

Checked with `npm view node-pty versions dist-tags` and by listing `prebuilds/` in the `1.1.0`, `1.2.0-beta.1` … `beta.15` tarballs. Once a stable `node-pty` release ships the Linux prebuilds, the pin moves to it.

### When `node-pty` can't be loaded

Only the terminal panel is affected; the daemon, the Agents and everything else keep working.

- No prebuild for the machine (for example Linux on musl/Alpine, 32-bit ARM, or glibc older than 2.28), a binary that fails to load, or `node-pty` missing because an install that does run scripts failed to build it: `node-pty` is loaded lazily, only when a terminal is opened, and the load error is caught and logged (`node-pty 加载失败，终端退化无 PTY 方案` in `logs/`).
- `pty.spawn` throwing (for example macOS `posix_spawnp failed`) is caught the same way. On macOS the exec bit of `spawn-helper` is restored first, since some extractions drop it.
- In both cases the terminal opens as a plain shell over pipes, and the panel shows "Simple terminal (no full TTY programs)". Commands run and print, but full-screen programs (vim, top, less) and line editing need a real TTY and don't work there.
- `node-pty` is an `optionalDependency`, so an `npm install` that runs install scripts and can't build it still installs the plugin.

`test/v1/terminal-fallback.test.ts` covers both cases: `node-pty` failing to import and `pty.spawn` throwing.

## Data directory

```
$XDG_CONFIG_HOME/magpie/agent-console/   (default ~/.config/magpie/agent-console on every OS;
                                           on Windows ~ is %USERPROFILE%, the same root Magpie uses)
  daemon.json          pid/port/token/version of the running daemon (mode 0600)
  settings.json        settings (default Agent / permission / send key / panel widths…)
  projects.json        project list
  threads/<id>/        meta.json + timeline.jsonl (event persistence, replay on reconnect)
  attachments/         uploaded files
  trash/               deleted threads and discarded new files (not hard-deleted)
  logs/                daily rotating logs (kept 7 days); logs/daemon-spawn.log has the plugin host's view
```

Magpie in portable mode keeps its own config next to the executable, but this plugin still uses the directory above (it follows `XDG_CONFIG_HOME`).

## Development

In `packages/agent-console`, after `npm ci --workspaces=false` (use `npm install --workspaces=false` too when changing dependencies, so the lockfile stays in this folder):

```bash
npm run build      # daemon esm + web iife (app/ and daemon/dist are committed)
npm run verify:build  # check committed bundles match a clean build
npm run dev        # daemon on port 3499, data dir _tmp/xdg-dev (does not touch real data)
npm run check      # typecheck both tsconfigs
npm test           # vitest (test/v1 + web/src); the repository's root `bun test` skips these (bunfig.toml) and runs agent-console.test.mjs
npm run e2e:v1     # e2e: spawn daemon(3497) + Edge/Chrome/Chromium, Mock Agent (MSEDGE_PATH / CHROME_PATH to override)
node scripts/verify-windows.mjs [--quick]   # one-command platform self-check, see docs/VERIFY-windows.md
npm run shot:v1    # screenshot set (light/dark × scenes → _tmp/shots-v1/)

# Mock (no real tokens)
AGENT_CONSOLE_MOCK=1 npm run dev
# scripts: default /perm /plan /ask /slow /error /long (5000-event stress) /exit
```

| Env | Purpose |
|---|---|
| `AGENT_CONSOLE_PORT` | gate port in the plugin / daemon port in standalone mode (3488; plugin `options.port` wins) |
| `AGENT_CONSOLE_MOCK=1` | register the mock provider |
| `AGENT_CONSOLE_TOKEN` | fixed page token (tests/screenshots only; do not set in production) |
| `AGENT_CONSOLE_IDLE_EXIT_MIN` | idle auto-exit minutes (default 60) |
| `XDG_CONFIG_HOME` | data root (`_tmp/xdg-dev` in development) |

Daemon CLI: `node daemon/dist/main.js [--port N|0] [--data DIR] [--token T] [--parent-pid PID]`. In standalone mode (no `--parent-pid`) it prints the URL to open, `http://127.0.0.1:<port>/#t=<token>`, to the console.

## License

MIT (see LICENSE). Third-party licenses are in THIRD-PARTY-NOTICES.md: the 6 installed packages and the 11 bundled into `app/app.js` (mostly MIT; DOMPurify MPL-2.0/Apache-2.0, highlight.js BSD-3-Clause, lucide-react ISC; `@anthropic-ai/claude-agent-sdk` is Anthropic's commercial terms). Build/test: esbuild, vitest, TypeScript, playwright-core.

Architecture takes cues from Paseo (persistent daemon + provider abstraction) and T3 Code (timeline shape and three-column layout) — ideas only, no copied code.
