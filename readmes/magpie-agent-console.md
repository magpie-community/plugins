# Agent Console

**把终端里的 Agent CLI 搬进 magpie 窗口，直接对话使用。**

作者 qingnian108，源码在 [qingnian108/magpie-agent-console](https://github.com/qingnian108/magpie-agent-console)，欢迎提问题和建议。

支持 Claude Code、Codex、Cursor 等，直接用你电脑上已安装的 CLI。左边是项目和对话，中间聊天，右边看改动、文件和终端。

**Use your terminal Agent CLIs right inside magpie, by chat.**

By qingnian108. Source: [qingnian108/magpie-agent-console](https://github.com/qingnian108/magpie-agent-console). Issues welcome.

Works with Claude Code, Codex, Cursor and more, using the CLIs you already have.

---

A Magpie page plugin that drives real local Agent CLIs (Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin, dsh). Each conversation is a **persistent Agent session** on a standalone Node daemon. Close or refresh the page — the Agent keeps running while Magpie is open. Reopen the page and you pick up where you left off. When Magpie quits, the daemon and its Agents stop; threads are persisted and can be resumed next time.

## Install

Requires [Magpie](https://usemagpie.ai) ≥ 0.1.1340 and Node.js ≥ 20.

```bash
magpie plugin add magpie-agent-console
```

Or in Magpie: **Settings → Plugins → Add plugin**, enter `magpie-agent-console` (or find **Agent Console** in Discover). After install, **Agent Console** appears in the sidebar plugin group.

Install the Agent CLIs you want to use (for example `claude` or `codex`). Missing CLIs show an install hint in Settings.

A cold install is about **46 MB** of `node_modules`, mostly `node-pty`'s native terminal module (~26 MB). Claude Code is **not** bundled: to use the Claude Code Agent, install the `claude` CLI yourself (`npm i -g @anthropic-ai/claude-code` or Anthropic's native installer). / 冷安装约占 **46 MB** 的 `node_modules`，主要是 `node-pty` 原生终端模块（约 26 MB）。插件**不**附带 Claude Code：要用 Claude Code Agent，请自行安装 `claude` CLI（`npm i -g @anthropic-ai/claude-code` 或 Anthropic 的原生安装器）。

---

This is not a gateway chat box. The daemon talks to the real CLIs through `claude -p --input-format stream-json --output-format stream-json` (the user's own `claude`, with its control messages for permissions, interrupt, model and mode), `codex app-server`, and ACP, normalizes a structured event stream (tool calls, thinking, permission requests, usage), and pushes it to the React page over WebSocket.

UI principle: **obvious at a glance, nothing extra**. Three columns — sidebar (projects × threads), conversation timeline, and a right panel (changes / files / terminal).

## Features

- **Persistent sessions**: each thread binds to a long-lived Agent process; after a daemon restart, running threads are marked closed and can be resumed (`--resume` / `thread/resume`)
- **Multiple Agents**: Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin, dsh; missing CLIs show an install hint
- **Model / permission / thinking**: per-thread; four permission modes and five thinking levels (what each Agent actually supports)
- **全部自动同意 / Auto-approve all (1.3)**: a permission mode for every Agent; the default stays 每次询问 / Always Ask. While a conversation is in it, a one-line strip above the composer (全部自动同意已开启 on the left, whose tooltip says what it does for this Agent, and a 改回每次询问 link on the right) and a warning-coloured mode chip stay on screen, at any width and in light and dark. What it does per Agent, as the menu hint says:

  | Agent | What 全部自动同意 turns on |
  | --- | --- |
  | Codex | `approvalPolicy: never` + `sandbox: danger-full-access`: **the sandbox is off**, nothing asks |
  | Claude Code | `--permission-mode bypassPermissions` (started with `--allow-dangerously-skip-permissions`): **skips all permission checks** |
  | Copilot | its Allow All (`allow_all` on, agent mode) |
  | Devin CLI | its Bypass Permissions mode |
  | Cursor, OpenCode, dsh | no switch over ACP: Agent / Build mode, and the daemon answers each approval request with its **allow once** option |
  | Pi | Pi never asks before its tools anyway (its extensions' own dialogs still ask you) |

  The daemon only ever answers with the option for that one request (allow once / accept), never allow-always, so no lasting rule is written into the Agent's own config; when a request offers nothing narrower, the card stays for you. Plan approvals and questions are never answered for you. Every approval it gives is saved in the conversation (`permission_request` + `permission_resolved`, both `auto: true`) and shown as a quiet row after its tool calls, 已自动同意 3 项 · npm test · git status, that opens to each request's title, command or file and the answer. Turning the mode on also approves a card that is already waiting. Only the page (with its token) can switch it on.

  **Upgrading from 1.2.** 1.2's 全部放行 (`bypassPermissions`) did nothing for Cursor and OpenCode (they had no such mode, so it fell back to 每次询问) and dsh still asked; from 1.3 the same setting would really auto-approve for them. It is not escalated silently: on the first 1.3 start, Cursor / OpenCode / dsh conversations saved in that mode go back to 每次询问 with a notice in the conversation, and if your default permission mode was 全部放行, new Cursor / OpenCode / dsh conversations keep starting in 每次询问; the first one shows a notice that the new mode exists, with a button to turn it on there. Claude Code, Codex, Copilot and Devin keep the mode, which already meant the same in 1.2. Choosing the default permission mode again in Settings ends this.
- **Structured timeline**: user message → thinking (expandable) → tool calls (read / edit / command, with line-level diffs) → todos → usage and duration; answer permission requests (tools / plan / questions) on the card. Since 1.3 every tool call is one compact row: a type icon, the command or path (monospace, relative to the project, never wrapping), `+N -M` for an edit and the status on the right; click a row for its output or diff, and a failed step opens by itself. A run of more than 6 tool calls (with the short thinking between them) folds into one summary row (改动 2 · 运行 3 · 读取 4 · 搜索 1 · 1 失败) that expands to the same rows; while it runs, one line shows the current step (正在运行：npm test…). The Agent's step list (Claude Code TodoWrite, Codex plan updates, an ACP agent's plan) is a checklist with N/M, and while it has open items an "N/M 个任务" pill above the composer jumps to it. Each reply ends with 复制 · model · time · duration (plus tokens / cost when the Agent reports them). Code blocks have a language label, line numbers, a wrap toggle and a copy button (the copy is the raw code). A block written without a language is detected by highlight.js (`highlightAuto`), coloured and labelled with what it found; while a reply streams, that happens as soon as the block's closing fence arrives (an open block stays plain "text" so its colours and label don't flip with every token), and results are cached so a closed block isn't detected again on every frame (1.3.7). Since 1.3.7 code blocks are drawn in the same pass as the Markdown, so a streaming reply no longer flickers; the Agent's Markdown is sanitized by DOMPurify with the HTML profile only (an `<svg>` the Agent writes is dropped), and the code block icons are added after sanitizing. The look is grayscale and was inspired by [Better Paseo](https://github.com/RoundRedDot/better-paseo) (MIT); no code was copied
- **Instant send (1.3)**: your message shows in the timeline the moment you click 发送 and the composer switches to working at once. The daemon saves and pushes the message before it starts the Agent (spawn + ACP `initialize` / `session/new`, seconds on Windows) instead of after; the page draws it right away and swaps in the daemon's copy by a client message id, so it neither doubles nor jumps. A send that fails stays in place marked 发送失败 with 重试 / 移除. A message sent while a turn runs still goes to the queue list
- **Steer and queue**: steer while running, queue the next message, interrupt
- **Changes panel**: git status refresh every 3s, unified per-file diffs; discarded untracked files go to trash instead of a hard delete
- **Files panel**: lazy directory tree (respects `.gitignore`), syntax-highlighted preview
- **Terminal panel**: real PTY via node-pty (pwsh / powershell); reconnects after reopening the page; degrades if PTY is unavailable
- **Images**: attach or paste images (and text files). Only PNG, JPEG, GIF and WebP are sent as images. Claude Code and Codex take them natively; Claude Code gets a text file (up to 1 MB) as a plain-text document, Codex gets its path; any other file (SVG, binaries, images over Claude's 5 MB limit) goes by path, with a notice. An ACP Agent (Cursor, Copilot, OpenCode, Pi, Devin CLI, dsh) gets image blocks when its ACP `initialize` advertises `promptCapabilities.image`; otherwise it gets each image's file path (as text and a `resource_link`), so it can open it with its file tools, and the timeline says it can't see the image itself. The composer says so before you send once the Agent has been asked. dsh answers `initialize` for the route its ACP starts on (its `acp` config row, which ships as a model dsh's catalog doesn't have) and refuses image blocks otherwise, so Agent Console starts dsh with a `--patch` overlay that puts that row on the conversation's model: on a model that sees images (Magpie writes those as `input: [text, image]`) dsh then takes image blocks; after a switch to another model in the same chat, images go by path and dsh opens them with its `read_image` tool. Checked on 2026-10-31 with the real CLIs, a throwaway HOME, no sign-in and a local stand-in for the model API (`npm run test:real`, see `test/real/`): the image reaches the model request from Claude Code 2.1.316 (stream-json), Codex 0.165.0, Copilot 1.0.105 (BYOK), OpenCode 1.19.5, Pi (pi-acp 0.0.34 + pi 1.4.0) and dsh 0.2.1-rc.5; Devin CLI 3000.11.234 and Cursor 2026.10.22 advertise images and Devin gets the image block, but both need a sign-in to run a model. Inline media is capped at 10 MB per file and 16 MB per message (an ACP SDK peer refuses messages over 32 MB); larger images go by path
- **Import history**: import matching sessions from `~/.claude/projects` and `~/.codex/sessions` as new threads (resumable)
- **Thread management**: search (Ctrl+K), pin, rename, archive, delete (trash), export Markdown, thread info (usage / cost / session ID)
- **Preview tab** (1.2): a small browser in the right panel for local dev servers (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `0.0.0.0`): address bar, back / forward, reload, open in the system browser, widen the panel. The address is remembered per conversation. Pages load through the daemon's local preview proxy (see the security model), so module scripts, `fetch` and HMR WebSockets work inside Magpie's sandboxed frame. Limits: popups, `alert` and native form posts don't run in the sandbox; `localStorage` / `sessionStorage` / `document.cookie` are in-memory and reset on reload, and cookies are not passed (use 用浏览器打开 / Open in browser for logins)
- **Links in chat** (1.2): local addresses in agent text, rendered Markdown and tool output (`localhost:5173`, `http://127.0.0.1:8080/x`, …) become links that open in the Preview tab; Ctrl/⌘+click, and any other `http(s)` link, opens the system browser through the daemon (`app.openExternal`: http/https only, re-serialized, run with `execFile` and no shell: `rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` on Linux; if that fails the link is copied). The terminal is not linkified
- **File chips** (1.2): drag a row from the Files tab into the composer, or right-click → 插入到聊天 / Add to chat, to attach a path chip. Chips are sent as project-relative paths, checked by the daemon (inside the project, no `..`, no symlink escape, must exist, at most 50), and reach the Agent as a "Referenced files" section with absolute paths after your text (plus `resource_link` blocks for ACP Agents). Dropping files from the OS file manager still uploads them as attachments
- **Layout settings** (1.2): content width (narrow 640 / default 720 / wide 880 / full) and chat font size (12–18 px, default 13; timeline, composer, tool cards, diffs and the file viewer scale together, code 1 px smaller; the sidebar, top bar, panel tabs, menus and dialogs stay on the fixed 13 px UI scale); the sidebar collapses with the panel button at its top-left or Ctrl/⌘+B (collapses automatically in narrow windows); all persisted
- **Follows Magpie live** (1.2): light/dark, Magpie's neutral colours and its language follow Magpie while the page is open (and after a reconnect); the accent stays neutral grey
- **Mock Agent**: `AGENT_CONSOLE_MOCK=1` registers a demo Agent with 11 scripts (`default` / `perm` / `plan` / `ask` / `slow` / `error` / `long` / `exit` / `serve` / `tools` / `bashhint`) so UI work does not burn tokens

## Architecture

```
Magpie window
 └─ page/index.html  (sandbox="allow-scripts" iframe, served by Magpie from /_magpie/plugin/<per-run id>/)
     │ reads page/session.js  {port, key}  (gate key only, written by the plugin host)
     │ navigates itself to  http://127.0.0.1:<port>/open?k=<key>&theme=…
     ▼
Magpie plugin host (Bun) ── index.mjs + lib/gate.mjs  "gate" on 127.0.0.1:<port> (default 3488)
     │ first /open: spawns the daemon as a child process (node, --port 0, stdin lifeline, --parent-pid)
     │ 302 → http://127.0.0.1:<port>/app?theme=…#t=<token>&p=<daemonPort>   (1.3: the gate's wrapper page, lib/wrapper.mjs)
     │        └─ <iframe src="http://127.0.0.1:<daemonPort>/?theme=…#t=<token>&w=1">
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
- The gate answers only `GET /open?k=<gate key>` (the daemon token is not accepted there) and `GET /app` (1.3, below), refuses any request that carries an `Origin` header, and sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- WebSocket connections must send `hello` with the token within 5 seconds, otherwise they are closed with code 4401.
- **Coming back after sleep / a daemon restart (1.3).** Before 1.3 the plugin frame sat on the daemon's random port; when the daemon was gone after sleep and the WebView reloaded the frame, it showed "127.0.0.1 拒绝连接" with none of our script left to recover. Now `/open` redirects to the gate's own `GET /app`, a static page that frames the daemon page, so a reload lands on the stable gate port. The daemon page (told by `w=1`) posts `{ac_console:"alive"}` to it every 2 s while its WebSocket is open and `{ac_console:"lost"}` after 5 s without it; no alive within 12 s (6 s after the child frame loaded), a lost, or 15 s of silence while visible (time the wrapper's own timers were suspended doesn't count) sends the frame back through the Magpie page (`b`, as below), which restarts the daemon. At most 3 automatic tries in 2 minutes (`ac_try`), then a button. Coming back to the page (`visibilitychange` → visible, or window focus) checks at once instead of waiting out the timers pushed back while hidden: if the child never said alive within 12 s of loading or its last real alive is older than 15 s, it gets 4 s (two heartbeats) to speak up before the same recovery runs; a child that answers is left alone. If a disconnect end state is showing, coming back counts as clicking Reconnect, also when the automatic tries are used up. The wrapper holds no secret of its own: the token arrives only in its fragment and goes on only in the child's fragment, the gate key never reaches it, the child is always `http://127.0.0.1:<integer port>/`, `b` passes the same loopback Magpie-page check, only the Magpie theme protocol is relayed (theme events and hello answers down, the hello call up, messages checked by `event.source`), and it is served with a per-response nonce CSP (`default-src 'none'`, `frame-src http://127.0.0.1:*`, and `frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* http://wails.localhost:* wails:`, so only a loopback page or Magpie's own desktop window can frame it). Host and Origin checks apply to `/app` like to `/open`.
- **Coming back after a plugin host restart.** Magpie restarts its plugin host from time to time; the old host's daemon exits with it and the new host has a new gate key. `boot.js` passes its own page URL to the gate as `back`; the gate accepts it only if it is a loopback `/_magpie/plugin/<id>/index.html` URL and forwards it **only in the fragment** (`#t=…&b=…`). When the daemon page can't reconnect for 5 seconds (or on 重试 / Retry) it navigates back to that page, which reads the fresh `session.js` and opens the new gate. In Magpie's desktop window (`wails://localhost` on macOS / Linux, `http://wails.localhost` on Windows) there is no loopback `back`, and none is ever taken: the wrapper posts `{magpie: 1, method: "error"}` to the window instead, Magpie swaps the frame for its "This page stopped working" card at once, and its Try again builds a new frame on the Magpie page (fresh `session.js` → new gate → new daemon). 1.3.5 / 1.3.6 also took `http://wails.localhost` as `back` on Windows, but WebView2 doesn't route that request from a frame that is on `127.0.0.1` (Wails intercepts `wails.localhost` with the filter that skips out-of-process iframes), so the frame ended on WebView2's gray error page with nothing of ours left to recover. To tell a live host's `session.js` from one a killed host left behind (a hard kill can't delete it), the file carries `ts` and `beat`: from the first page open on, the host rewrites it every 4 s, and after a lost connection `boot.js` only takes a file written after the loss; a host that was never opened doesn't rewrite it, and a new host deletes a file whose writer (pid in `session-owner.json`, outside the page folder) is gone before Magpie serves the page. The daemon page checks the URL again before following it, so it is never an open redirect, and the token never leaves its own fragment.

### Preview proxy (1.2)

The Preview tab can't frame a dev server directly: Magpie's frame is sandboxed without `allow-same-origin`, so the page would run with an opaque origin and module scripts, `fetch` and storage break. The daemon runs a small reverse proxy instead:

- **Created only over the authenticated WebSocket** (`preview.open`); there is no HTTP route to start one.
- **Loopback targets only**: `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`/`::`, `http:` or `https:`, no user-info, at most 2048 characters. Anything else is refused before a socket is opened.
- **Refused ports**: the daemon's own port, the gate (`--gate-port`, 3488), Magpie (3425, 3430, any port in `MAGPIE_ADDR` / `MAGPIE_WEB_ADDR` / `MAGPIE_URL`, and the gateway port saved in Magpie's own `settings.json`, read again on every open: the portable `data` folder beside Magpie, `$XDG_CONFIG_HOME/magpie`, `~/.config/magpie`), the proxy's own ports, plus `AGENT_CONSOLE_PREVIEW_DENY` (comma-separated). Whatever the port, a target whose `GET /` answers like Magpie's gateway (`{"name":"magpie",…}`), or that replies with `X-Magpie-*` headers, is refused; the check is repeated every minute and fails closed (no answer → nothing forwarded).
- **A key on every request**: each listener answers only at `http://ac<128-bit random key>.localhost:<port>`. The preview frame is an opaque origin (Magpie's sandbox is inherited), so its requests carry `Origin: null` and no `Referer`, exactly what any other web page can send from a sandboxed iframe of its own, and the port can be found by scanning. The host name is the one thing the browser attaches to every request the frame makes (navigations, module scripts and their imports, `fetch`, CSS `url()`, workers, the HMR WebSocket) that another page can't know. A request with any other `Host` is refused before anything is forwarded and gets no CORS headers: `127.0.0.1:<port>` / `localhost:<port>` → 403, anything else → 421 (DNS rebinding). Responses carry `Referrer-Policy: no-referrer` so the key isn't sent on to other sites. `preview.open` also returns a per-open nonce over the authenticated WebSocket; `GET /__agent_console__/ping` must echo it exactly (a plain 200 `ok` from a hostile DNS answer is refused and the listener is released). Before the keyed name is looked up, the panel probes a keyless canary (`acprobe<random>.localhost` on the same port) the same way. Apple WebKit before macOS 26 (Magpie's Mac app on 12–15, Safari with `magpie web`) asks network DNS for `*.localhost`, so it is refused before any such name is looked up and the listener is released. The macOS version doesn't come from the user agent (Apple froze it at `Mac OS X 10_15_7`, macOS 26+ included): `preview.open` reports the daemon's own `os.platform()` and the Darwin major of `os.release()` (25 = macOS 26), and the panel refuses only Apple WebKit on a Darwin host below 25, or when that answer is missing. The daemon listens on 127.0.0.1 only, so the page and the daemon run on the same machine; the keyless canary stays as the runtime check either way. Chromium / WebView2, WebKitGTK and WebKit on macOS 26+ resolve `*.localhost` to loopback themselves. Where the preview can't run, the panel offers the system browser instead.
- **One listener per target origin** on `127.0.0.1` with a random port (at most 8, least recently used closed first). Every request and upgrade checks `Host` (above) and `Origin` (absent, `null` or the proxy's own origin, else 403).
- **Headers**: upstream gets the target's `Host` and `Origin`; `Cookie`, `Forwarded` and `X-Forwarded-*` are dropped. Responses lose `X-Frame-Options`, the CSP `frame-ancestors` directive, `Set-Cookie` and upstream CORS headers; same-target redirects are rewritten to the proxy; CORS is answered for the opaque frame only, and only on requests that carry the key (`access-control-allow-origin: null`, no credentials). Cookies are dropped both ways because cookies for `127.0.0.1` are shared across ports. HTML gets one injected script (`/__agent_console__/preview.js`) that reports the address and title to the panel and accepts back / forward / reload from the parent frame only.
- **Closed when idle**: after 10 minutes without traffic (an open HMR socket counts as traffic), when the Preview tab closes or changes origin, when the last WebSocket client disconnects, and on daemon exit.

## Lifecycle

- Importing `index.mjs` has no side effects (no port, no process, no files).
- `server()` (called by Magpie's plugin host at host start-up — this includes short-lived hosts started by CLI commands such as `magpie plugin add` or `magpie plugin list`) binds the gate and writes `page/session.js`. If the port is busy it retries every 2 s in the background without blocking the host; a detached 0.1.0 daemon still holding the port is shut down once, only after it proves its identity by answering `/api/ping` with the token from `daemon.json`.
- The daemon starts when the page is opened for the first time and is reused for later opens. It is a normal (non-detached) child of the plugin host.
- `server()` waits ~1.2 s before binding the gate (`AGENT_CONSOLE_BIND_DELAY_MS`), so the short-lived hosts started by `magpie` CLI commands usually exit before they take the gate or write `session.js`; a gate port held by the long-lived host is logged only if it stays busy for ~10 s.
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
- **Git Bash for the agents (1.3).** On Windows `bash` on `PATH` is often `C:\Windows\System32\bash.exe`, the WSL launcher. The daemon looks for Git Bash next to `git.exe` on `PATH`, then in Program Files / Program Files (x86) / `%LOCALAPPDATA%\Programs\Git` / scoop, then `X:\Git` and `X:\Program Files\Git` on the other drives (probed in a short-lived child process with a 1.5 s limit, so a dead network drive can't stall it), never taking System32 / SysWOW64 / WindowsApps bash; 设置 → Bash 路径 / Settings → Bash path overrides it (validated). Each Agent spawn gets `CLAUDE_CODE_GIT_BASH_PATH` (Claude Code), `OPENCODE_GIT_BASH_PATH` (OpenCode) and Git's `bin` first on `PATH` (Pi's `where bash.exe`, dsh's `bash`) — per spawn only, no user config file is written and the terminal keeps your own environment. When none is found, Claude Code / Pi / dsh conversations show a hint with a Git for Windows link. Nothing changes on macOS / Linux.
- **Encoding.** Agent protocol output is UTF-8. Raw process output (Agent stderr, version / model probes, git errors, the no-PTY terminal) is decoded per chunk: valid UTF-8 stays UTF-8, anything else on Windows is read in the system ANSI code page (GBK on Chinese Windows) with Node's built-in `TextDecoder`, keeping at most 3 bytes of a character split across chunks; the PTY terminal already gets UTF-8 from ConPTY. The folder picker falls back to GBK (CP936); the file preview tries UTF-8, then GBK. Git runs with `core.quotepath=false` so Chinese file names show as-is.
- **Magpie desktop window → `http://127.0.0.1`.** Magpie's window origin is `wails://` on macOS/Linux and `http://wails.localhost` on Windows. The plugin frame navigates itself to the gate on `http://127.0.0.1`, as Magpie's plugin-runtime docs describe for page plugins. On macOS, Magpie's `Info.plist` has no ATS keys and ATS exempts IP-address hosts by default, and the main window has no CSP that could block the frame, so the navigation is allowed. This is the one item that still needs a run on a real Mac.
- **Clickjacking / `frame-ancestors`.** The gate's `/app` wrapper (1.3) allows only loopback pages (`'self'`, `http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`) and Magpie's desktop window (`wails:` on macOS / Linux, `http://wails.localhost:*` on Windows) as its ancestors. `magpie web` opened through a non-loopback address (a LAN IP or a reverse proxy) is not in that list, so open it as `http://127.0.0.1:<port>` / `http://localhost:<port>` on the same computer to use the console there. The daemon page sets no `frame-ancestors` of its own: the wrapper is its only parent. Getting a working console into any frame still requires the gate key, which only Magpie's per-run page path hands out, and the token, which only travels in the gate's redirect fragment.

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

- **Installed for users** (`dependencies`): `@agentclientprotocol/sdk`, `ignore`, `ws`, `zod`. These are what `daemon/dist/main.js` imports (esbuild bundles it with `packages: "external"`, so every package it imports is loaded from `node_modules`); `index.mjs` itself only imports `ws`.
- **Optional** (`optionalDependencies`): `node-pty`, for the terminal panel only (see below).
- **Build only** (`devDependencies`): the UI packages `react`, `react-dom`, `@xterm/xterm`, `@xterm/addon-fit`, `lucide-react`, `marked`, `dompurify`, `highlight.js`, `zustand`, `@tanstack/react-virtual` and `clsx` are bundled into `app/app.js` and never loaded from `node_modules` at run time, plus esbuild, TypeScript, vitest and type packages.
- No Claude Code or Anthropic package is installed or bundled: the Claude Code Agent is the user's own `claude` CLI, started per conversation and driven over its stream-json protocol (`daemon/src/providers/claude/cli.ts`).

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
# scripts: default /perm /plan /ask /slow /error /long (5000-event stress) /exit /serve (local links, 1.2)
#          /tools (8 tool calls → folded summary) /winrun (long Windows commands + an approval) /tasks (checklist + code block) /bashhint (1.3)
```

| Env | Purpose |
|---|---|
| `AGENT_CONSOLE_PORT` | gate port in the plugin / daemon port in standalone mode (3488; plugin `options.port` wins) |
| `AGENT_CONSOLE_MOCK=1` | register the mock provider |
| `AGENT_CONSOLE_MOCK_START_MS` / `AGENT_CONSOLE_MOCK_DETECT_MS` | mock only: delay the Agent start / detection (a slow start like real Agents on Windows; e2e uses `E2E_MOCK_START_MS`, default 1200) |
| `AGENT_CONSOLE_TOKEN` | fixed page token (tests/screenshots only; do not set in production) |
| `AGENT_CONSOLE_IDLE_EXIT_MIN` | idle auto-exit minutes (default 60) |
| `XDG_CONFIG_HOME` | data root (`_tmp/xdg-dev` in development) |

Daemon CLI: `node daemon/dist/main.js [--port N|0] [--data DIR] [--token T] [--parent-pid PID]`. In standalone mode (no `--parent-pid`) it prints the URL to open, `http://127.0.0.1:<port>/#t=<token>`, to the console.

## License

MIT (see LICENSE). Third-party licenses are in THIRD-PARTY-NOTICES.md: the 5 installed packages and the 11 bundled into `app/app.js` (mostly MIT; DOMPurify MPL-2.0/Apache-2.0, highlight.js BSD-3-Clause, lucide-react ISC). Build/test: esbuild, vitest, TypeScript, playwright-core.

Architecture takes cues from Paseo (persistent daemon + provider abstraction) and T3 Code (timeline shape and three-column layout), and the 1.3 timeline look from Better Paseo (MIT) — ideas only, no copied code.
