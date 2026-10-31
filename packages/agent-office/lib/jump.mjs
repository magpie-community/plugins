// Finds the terminal tab, multiplexer pane or desktop window where a live
// session is open, and brings it to the front when the user clicks Jump.
//
// Pure functions (parsePs, walkAncestors, parseHerdrPanes, parseTmuxPanes,
// resolveTarget, buildJumpPlan) take the process table and session records
// as values so tests drive every branch without touching the system.
// createJumper wraps the host side: it refreshes the process snapshot
// asynchronously and never trusts a target or path supplied in options.
import { execFile } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TTY_RE = /^\/dev\/ttys?\d+$/
const GUID_RE = /^[A-Za-z0-9_:-]{1,64}$/

function homeDir() {
  return process.env.HOME || homedir()
}

function extraPath() {
  return [
    join(homeDir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":")
}

export function validTty(tty) {
  return typeof tty === "string" && TTY_RE.test(tty)
}

export function appleScriptQuote(s) {
  return String(s || "").replace(/[\r\n\0]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function envWithPath() {
  const ep = extraPath()
  return { ...process.env, PATH: ep + (process.env.PATH ? ":" + process.env.PATH : "") }
}

function findBin(name, candidates = []) {
  for (const c of candidates) if (c && existsSync(c)) return c
  for (const d of extraPath().split(":")) {
    const p = join(d, name)
    if (existsSync(p)) return p
  }
  return name
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e?.code !== "ESRCH" }
}

function runAsync(bin, args = [], timeout = 1200) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: envWithPath(), encoding: "utf8", timeout }, (err, stdout) => {
      resolve(err ? "" : String(stdout || ""))
    })
  })
}

// `ps -axo pid=,ppid=,tty=,comm=,args=` turned into Map(pid -> { pid, ppid, tty, ttyShort, comm, args })
export function parsePs(text) {
  const procs = new Map()
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const ttyRaw = m[3]
    const comm = m[4]
    const args = m[5] || comm
    const tty = ttyRaw && ttyRaw !== "??" && ttyRaw !== "-" ? (ttyRaw.startsWith("/dev/") ? ttyRaw : "/dev/" + ttyRaw) : ""
    procs.set(pid, { pid, ppid, tty, ttyShort: tty ? tty.replace("/dev/", "") : "", comm, args })
  }
  return procs
}

export function detectHostApp(p) {
  if (!p) return null
  const s = (p.comm + " " + p.args).toLowerCase()
  if (s.includes("/applications/otty.app/")) return { id: "otty", kind: "otty", app: "Otty", label: "Otty", bundleId: "io.appmakes.otty" }
  if (s.includes("herdr-core") || s.includes("herdr-app") || s.includes("/applications/herdr.app/")) return { id: "herdr-app", kind: "herdr-app", app: "Herdr.app", label: "Herdr.app", bundleId: "dev.herdr.app" }
  if (s.includes("/applications/iterm.app/") || s.includes("iterm2")) return { id: "iterm2", kind: "iterm2", app: "iTerm2", label: "iTerm2", bundleId: "com.googlecode.iterm2" }
  if (s.includes("/utilities/terminal.app/")) return { id: "terminal", kind: "terminal", app: "Terminal", label: "Terminal", bundleId: "com.apple.Terminal" }
  if (s.includes("/applications/ghostty.app/")) return { id: "ghostty", kind: "ghostty", app: "Ghostty", label: "Ghostty", bundleId: "com.mitchellh.ghostty" }
  if (s.includes("/applications/warp.app/")) return { id: "warp", kind: "warp", app: "Warp", label: "Warp", bundleId: "dev.warp.Warp-Stable" }
  if (s.includes("wezterm")) return { id: "wezterm", kind: "wezterm", app: "WezTerm", label: "WezTerm", bundleId: "com.github.wez.wezterm" }
  if (s.includes("/applications/cursor.app/")) return { id: "cursor", kind: "ide", app: "Cursor", label: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92" }
  if (s.includes("/applications/visual studio code.app/")) return { id: "vscode", kind: "ide", app: "VS Code", label: "VS Code", bundleId: "com.microsoft.VSCode" }
  if (s.includes("/applications/antigravity.app/")) return { id: "antigravity", kind: "ide", app: "Antigravity", label: "Antigravity", bundleId: "com.google.antigravity" }
  if (s.includes("/applications/claude.app/")) return { id: "claude-desktop", kind: "claude-desktop", app: "Claude Desktop", label: "Claude Desktop", bundleId: "com.anthropic.claudefordesktop" }
  return null
}

export function walkAncestors(pid, procs) {
  const res = { tty: "", ttyShort: "", inHerdr: false, inTmux: false, app: null }
  let cur = Number(pid)
  const seen = new Set()
  while (cur > 1 && !seen.has(cur) && seen.size < 32) {
    seen.add(cur)
    const p = procs.get(cur)
    if (!p) break
    if (!res.tty && p.tty) { res.tty = p.tty; res.ttyShort = p.ttyShort }
    if (/\bherdr\s+server\b/.test(p.args)) res.inHerdr = true
    if (/\btmux\b/.test(p.comm) || /\btmux\b/.test(p.args)) res.inTmux = true
    const app = detectHostApp(p)
    if (app && !res.app) res.app = app
    cur = p.ppid
  }
  return res
}

export function parseHerdrPanes(text) {
  const bySession = new Map()
  const byCwd = new Map()
  try {
    const i = String(text || "").indexOf("{")
    if (i < 0) return { bySession, byCwd }
    const j = JSON.parse(String(text).slice(i))
    for (const p of j?.result?.panes || j?.result?.agents || []) {
      const info = {
        paneId: p.pane_id || "",
        tabId: p.tab_id || "",
        workspaceId: p.workspace_id || "",
        cwd: p.foreground_cwd || p.cwd || "",
        title: p.terminal_title_stripped || p.terminal_title || "",
      }
      const sid = p.agent_session?.value || ""
      if (sid) bySession.set(String(sid), info)
      const m = /--resume\s+([0-9A-Za-z-]{8,})/.exec(info.title)
      if (m && !bySession.has(m[1])) bySession.set(m[1], info)
      if (info.cwd && !byCwd.has(info.cwd)) byCwd.set(info.cwd, info)
    }
  } catch {}
  return { bySession, byCwd }
}

export function parseTmuxPanes(panesText, clientsText = "") {
  const byTty = new Map()
  const clientsBySession = new Map()
  for (const line of String(clientsText || "").split("\n")) {
    const [clientTty, clientPid, sessionName] = line.trim().split("\t")
    if (sessionName && clientTty) clientsBySession.set(sessionName, { clientTty, clientPid: Number(clientPid) || 0 })
  }
  for (const line of String(panesText || "").split("\n")) {
    const [paneId, paneTty, sessionName, windowIndex] = line.trim().split("\t")
    if (!paneId || !paneTty) continue
    const cl = clientsBySession.get(sessionName) || {}
    byTty.set(paneTty, { paneId, paneTty, sessionName: sessionName || "", windowIndex: windowIndex || "", clientTty: cl.clientTty || "", clientPid: cl.clientPid || 0 })
  }
  return byTty
}

function normalizeHosts(herdrHosts) {
  const list = Array.isArray(herdrHosts) && herdrHosts.length
    ? herdrHosts
    : [{ id: "herdr-app", app: "Herdr.app", label: "Herdr.app", bundleId: "dev.herdr.app" }]
  return list.map((h) => ({
    ...h,
    id: String(h?.id || "herdr-app"),
    app: String(h?.app || h?.label || "Herdr.app"),
    label: String(h?.label || h?.app || "Herdr.app"),
  }))
}

export function resolveTarget(s, state) {
  const platform = state?.platform ?? process.platform
  if (platform !== "darwin") return null

  const sid = String(s?.session || s?.id || "").replace(/^[^|]+\|/, "")
  const cwd = String(s?.cwd || "")
  const {
    liveFiles = new Map(),
    desktopIdx = new Map(),
    procs = new Map(),
    herdrBySession = new Map(),
    herdrByCwd = new Map(),
    herdrHosts = [],
    tmuxByTty = new Map(),
  } = state || {}

  const hp = sid ? herdrBySession.get(sid) : null
  const lf = sid ? liveFiles.get(sid) : null
  const walk = lf?.alive ? walkAncestors(lf.pid, procs) : null
  const hosts = normalizeHosts(herdrHosts)
  const primary = hosts[0]

  // 1. Session inside a Herdr pane
  if (hp && hp.paneId) {
    const label = `${primary.app} · ${hp.paneId}`
    return {
      kind: "herdr",
      hostId: primary.id,
      app: primary.app,
      label,
      badge: label,
      paneId: hp.paneId,
      detail: [hp.workspaceId, hp.tabId, hp.paneId].filter(Boolean).join(" / "),
      herdrWorkspace: hp.workspaceId,
      herdrTab: hp.tabId,
      herdrPane: hp.paneId,
      herdrAppSpace: primary.herdrAppSpace || "",
      herdrAppTab: primary.herdrAppTab || "",
      ottyPane: primary.ottyPane || "",
      outerBundleId: primary.bundleId || "dev.herdr.app",
      hosts,
      tty: validTty(walk?.tty) ? walk.tty : "",
      pid: lf?.pid || 0,
      live: true,
    }
  }

  // 2. Claude Desktop session
  const hostSid = lf?.hostSessionId || (sid ? desktopIdx.get(sid) : "") || ""
  if (lf?.entrypoint === "claude-desktop-3p" || hostSid) {
    return {
      kind: "claude-desktop",
      app: "Claude Desktop",
      label: "Claude Desktop",
      badge: "Claude Desktop",
      paneId: "",
      detail: hostSid || sid.slice(0, 8),
      hostSessionId: hostSid,
      bundleId: "com.anthropic.claudefordesktop",
      pid: lf?.pid || 0,
      live: !!lf?.alive || !!hostSid,
    }
  }

  // 3. Live process walked up the process tree (only known macOS apps or multiplexers)
  if (walk) {
    const safeTty = validTty(walk.tty) ? walk.tty : ""
    if (walk.inHerdr) {
      const cp = cwd ? herdrByCwd.get(cwd) : null
      const paneId = cp?.paneId || ""
      const label = paneId ? `${primary.app} · ${paneId}` : `${primary.app} · Herdr`
      return {
        kind: "herdr",
        hostId: primary.id,
        app: primary.app,
        label,
        badge: label,
        paneId,
        detail: [cp?.workspaceId, cp?.tabId, paneId].filter(Boolean).join(" / "),
        herdrWorkspace: cp?.workspaceId || "",
        herdrTab: cp?.tabId || "",
        herdrPane: paneId,
        herdrAppSpace: primary.herdrAppSpace || "",
        herdrAppTab: primary.herdrAppTab || "",
        ottyPane: primary.ottyPane || "",
        outerBundleId: primary.bundleId || "dev.herdr.app",
        hosts,
        tty: safeTty,
        pid: lf.pid,
        live: true,
      }
    }
    if (walk.inTmux && safeTty && tmuxByTty.has(safeTty)) {
      const tm = tmuxByTty.get(safeTty)
      const outer = tm.clientPid ? walkAncestors(tm.clientPid, procs).app : null
      const clientTty = validTty(tm.clientTty) ? tm.clientTty : ""
      const label = `${outer?.app || "tmux"} · ${tm.paneId}`
      return {
        kind: "tmux",
        app: outer?.app || "tmux",
        label,
        badge: label,
        paneId: tm.paneId,
        detail: [tm.sessionName, tm.windowIndex, tm.paneId].filter(Boolean).join(":"),
        tmuxPane: tm.paneId,
        tmuxWindow: tm.windowIndex ? `${tm.sessionName}:${tm.windowIndex}` : "",
        clientTty,
        outerKind: outer?.kind || "",
        bundleId: outer?.bundleId || "",
        tty: safeTty,
        pid: lf.pid,
        live: true,
      }
    }
    if (walk.app) {
      const suffix = safeTty ? ` · ${walk.ttyShort}` : ""
      const label = `${walk.app.app}${suffix}`
      return {
        kind: walk.app.kind,
        app: walk.app.app,
        label,
        badge: label,
        paneId: "",
        detail: safeTty || cwd,
        bundleId: walk.app.bundleId,
        tty: safeTty,
        pid: lf.pid,
        live: true,
      }
    }
  }

  return null
}

function appleScriptIterm(tty, sessionGuid = "") {
  const safeTty = validTty(tty) ? appleScriptQuote(tty) : ""
  const rawGuid = sessionGuid ? String(sessionGuid).split(":").pop() : ""
  const safeGuid = GUID_RE.test(rawGuid) ? appleScriptQuote(rawGuid) : ""
  if (!safeTty && !safeGuid) return ""
  return `
if application "iTerm2" is not running then return "not_running"
tell application "iTerm2"
  repeat with aWin in windows
    repeat with aTab in tabs of aWin
      repeat with aSess in sessions of aTab
        set matched to false
        if "${safeGuid}" is not "" and (id of aSess as text) contains "${safeGuid}" then
          set matched to true
        else if "${safeTty}" is not "" and (tty of aSess as text) is "${safeTty}" then
          set matched to true
        end if
        if matched then
          set miniaturized of aWin to false
          select aWin
          select aTab
          tell aSess to select
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  activate
  return "activated_only"
end tell`.trim()
}

function appleScriptTerminalApp(tty) {
  const safeTty = validTty(tty) ? appleScriptQuote(tty) : ""
  if (!safeTty) return ""
  return `
if application "Terminal" is not running then return "not_running"
tell application "Terminal"
  repeat with aWin in windows
    repeat with aTab in tabs of aWin
      if (tty of aTab as text) is "${safeTty}" then
        set selected tab of aWin to aTab
        set miniaturized of aWin to false
        set index of aWin to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
  activate
  return "activated_only"
end tell`.trim()
}

// Builds the jump plan strictly from host-resolved state; any `target` or `cwd`
// supplied on `req` (for example from plugins.json options) is ignored.
export function buildJumpPlan(req, state, bins = {}) {
  const home = homeDir()
  const B = {
    herdr: bins.herdr || findBin("herdr", [join(home, ".local", "bin", "herdr")]),
    herdrApp: bins.herdrApp || findBin("herdr-app", [join(home, ".local", "bin", "herdr-app"), "/Applications/Herdr.app/Contents/MacOS/herdr-app"]),
    ottyCli: bins.ottyCli || findBin("otty-cli", ["/Applications/Otty.app/Contents/MacOS/otty-cli"]),
    tmux: bins.tmux || findBin("tmux", ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]),
    osascript: bins.osascript || "/usr/bin/osascript",
    open: bins.open || "/usr/bin/open",
  }
  const sid = String(req?.session || req?.id || req?.key || "").replace(/^[^|]+\|/, "")
  const target = sid && state ? resolveTarget({ session: sid }, state) : null
  if (!target) return { ok: false, reason: "no_target", target: null, steps: [] }

  const steps = []
  switch (target.kind) {
    case "herdr": {
      const wantHostId = typeof req?.preferredHostId === "string" ? req.preferredHostId : (target.hostId || "")
      const hosts = Array.isArray(target.hosts) ? target.hosts : []
      const chosen = hosts.find((h) => h.id === wantHostId) || {
        id: target.hostId || (target.outerBundleId === "dev.herdr.app" ? "herdr-app" : "otty"),
        app: target.app || "Herdr.app",
        bundleId: target.outerBundleId || "dev.herdr.app",
        ottyPane: target.ottyPane || "",
        herdrAppSpace: target.herdrAppSpace || "",
        herdrAppTab: target.herdrAppTab || "",
        tty: target.tty || "",
      }
      if (target.herdrWorkspace) steps.push({ cmd: B.herdr, args: ["workspace", "focus", target.herdrWorkspace], desc: `herdr workspace focus ${target.herdrWorkspace}` })
      if (target.herdrTab) steps.push({ cmd: B.herdr, args: ["tab", "focus", target.herdrTab], desc: `herdr tab focus ${target.herdrTab}` })
      if (target.herdrPane) steps.push({ cmd: B.herdr, args: ["agent", "focus", target.herdrPane], desc: `herdr agent focus ${target.herdrPane}` })
      if (chosen.id === "herdr-app") {
        if (chosen.herdrAppSpace) steps.push({ cmd: B.herdrApp, args: ["do", "space.select", "--id", chosen.herdrAppSpace], desc: `herdr-app do space.select --id ${chosen.herdrAppSpace}` })
        if (chosen.herdrAppTab) steps.push({ cmd: B.herdrApp, args: ["do", "tab.select", "--id", chosen.herdrAppTab], desc: `herdr-app do tab.select --id ${chosen.herdrAppTab}` })
      } else if (chosen.id === "otty" && chosen.ottyPane) {
        steps.push({ cmd: B.ottyCli, args: ["pane", "focus", chosen.ottyPane], desc: `otty-cli pane focus ${chosen.ottyPane}` })
      } else if (chosen.id === "iterm2" && validTty(chosen.tty)) {
        const script = appleScriptIterm(chosen.tty)
        if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript iTerm2 select (${chosen.tty})` })
      } else if (chosen.id === "terminal" && validTty(chosen.tty)) {
        const script = appleScriptTerminalApp(chosen.tty)
        if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript Terminal select (${chosen.tty})` })
      }
      if (chosen.bundleId) steps.push({ cmd: B.open, args: ["-b", chosen.bundleId], desc: `open -b ${chosen.bundleId}` })
      break
    }
    case "claude-desktop": {
      if (target.hostSessionId && GUID_RE.test(target.hostSessionId)) {
        steps.push({ cmd: B.open, args: [`claude://resume?session=${target.hostSessionId}`], desc: `open claude://resume?session=${target.hostSessionId}` })
      }
      steps.push({ cmd: B.open, args: ["-b", "com.anthropic.claudefordesktop"], desc: "open -b com.anthropic.claudefordesktop" })
      break
    }
    case "iterm2": {
      const script = appleScriptIterm(target.tty, target.itermSessionId)
      if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript iTerm2 select (${target.tty})` })
      else steps.push({ cmd: B.open, args: ["-b", "com.googlecode.iterm2"], desc: "open -b com.googlecode.iterm2" })
      break
    }
    case "terminal": {
      const script = appleScriptTerminalApp(target.tty)
      if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript Terminal select (${target.tty})` })
      else steps.push({ cmd: B.open, args: ["-b", "com.apple.Terminal"], desc: "open -b com.apple.Terminal" })
      break
    }
    case "tmux": {
      if (target.tmuxWindow) steps.push({ cmd: B.tmux, args: ["select-window", "-t", target.tmuxWindow], desc: `tmux select-window -t ${target.tmuxWindow}` })
      if (target.tmuxPane) steps.push({ cmd: B.tmux, args: ["select-pane", "-t", target.tmuxPane], desc: `tmux select-pane -t ${target.tmuxPane}` })
      if (target.outerKind === "iterm2" && validTty(target.clientTty)) {
        const script = appleScriptIterm(target.clientTty)
        if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript iTerm2 select (${target.clientTty})` })
      } else if (target.outerKind === "terminal" && validTty(target.clientTty)) {
        const script = appleScriptTerminalApp(target.clientTty)
        if (script) steps.push({ cmd: B.osascript, args: ["-e", script], desc: `osascript Terminal select (${target.clientTty})` })
      } else if (target.bundleId) {
        steps.push({ cmd: B.open, args: ["-b", target.bundleId], desc: `open -b ${target.bundleId}` })
      }
      break
    }
    case "otty": {
      if (target.ottyPane) steps.push({ cmd: B.ottyCli, args: ["pane", "focus", target.ottyPane], desc: `otty-cli pane focus ${target.ottyPane}` })
      steps.push({ cmd: B.open, args: ["-b", "io.appmakes.otty"], desc: "open -b io.appmakes.otty" })
      break
    }
    default: {
      if (target.bundleId) steps.push({ cmd: B.open, args: ["-b", target.bundleId], desc: `open -b ${target.bundleId}` })
      break
    }
  }
  return { ok: steps.length > 0, target, steps }
}

// ---- Host-side asynchronous collector & jumper -----------------------------
export function createJumper(opts = {}) {
  const ttl = opts.ttl ?? 10_000
  const onUpdate = typeof opts.onUpdate === "function" ? opts.onUpdate : null
  let snap = { at: 0, state: opts.state || null, inflight: null }
  let desktopCache = { at: 0, map: new Map() }

  function readLiveFiles() {
    const home = homeDir()
    const bySession = new Map()
    for (const d of [".claude", ".qoder", ".qoder-cn", ".workbuddy", ".codebuddy"]) {
      const dir = join(home, d, "sessions")
      if (!existsSync(dir)) continue
      let names = []
      try { names = readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!/^\d+\.json$/.test(n)) continue
        try {
          const j = JSON.parse(readFileSync(join(dir, n), "utf8"))
          const pid = Number(j?.pid)
          const sid = String(j?.sessionId || "")
          if (!sid || !pid) continue
          const alive = pidAlive(pid)
          const prev = bySession.get(sid)
          if (!prev || (alive && !prev.alive) || (j.updatedAt || 0) > (prev.updatedAt || 0)) {
            bySession.set(sid, { pid, alive, sessionId: sid, cwd: j.cwd || "", entrypoint: j.entrypoint || "cli", hostSessionId: j.hostSessionId || "", updatedAt: j.updatedAt || 0 })
          }
        } catch {}
      }
    }
    return bySession
  }

  function readDesktopIndex(now) {
    if (now - desktopCache.at < 15_000 && desktopCache.map.size > 0) return desktopCache.map
    const home = homeDir()
    const map = new Map()
    for (const appDir of ["Claude-3p", "Claude"]) {
      const root = join(home, "Library", "Application Support", appDir, "claude-code-sessions")
      if (!existsSync(root)) continue
      let l1 = []
      try { l1 = readdirSync(root, { withFileTypes: true }) } catch { continue }
      for (const d1 of l1) {
        if (!d1.isDirectory()) continue
        const p1 = join(root, d1.name)
        let l2 = []
        try { l2 = readdirSync(p1, { withFileTypes: true }) } catch { continue }
        for (const d2 of l2) {
          if (!d2.isDirectory()) continue
          const p2 = join(p1, d2.name)
          let files = []
          try { files = readdirSync(p2) } catch { continue }
          for (const f of files) {
            if (!f.startsWith("local_") || !f.endsWith(".json")) continue
            try {
              const j = JSON.parse(readFileSync(join(p2, f), "utf8"))
              if (j?.cliSessionId && j?.sessionId) map.set(String(j.cliSessionId), String(j.sessionId))
            } catch {}
          }
        }
      }
    }
    desktopCache = { at: now, map }
    return map
  }

  async function refreshState(now = Date.now(), preferredHost = "herdr-app") {
    if (opts.state) return opts.state
    if (process.platform !== "darwin") {
      const st = { platform: process.platform, liveFiles: new Map(), desktopIdx: new Map(), procs: new Map(), herdrBySession: new Map(), herdrByCwd: new Map(), herdrHosts: [], tmuxByTty: new Map() }
      snap = { at: now, state: st, inflight: null }
      return st
    }
    if (snap.inflight) return snap.inflight
    snap.inflight = (async () => {
      const home = homeDir()
      const herdrBin = findBin("herdr", [join(home, ".local", "bin", "herdr")])
      const ottyBin = findBin("otty-cli", ["/Applications/Otty.app/Contents/MacOS/otty-cli"])
      const tmuxBin = findBin("tmux", ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"])

      const [psTxt, herdrTxt, ottyTxt] = await Promise.all([
        runAsync("/bin/ps", ["-axo", "pid=,ppid=,tty=,comm=,args="], 1200),
        existsSync(herdrBin) ? runAsync(herdrBin, ["pane", "list"], 1200) : Promise.resolve(""),
        existsSync(ottyBin) ? runAsync(ottyBin, ["pane", "list", "--json"], 1000) : Promise.resolve(""),
      ])

      const procs = parsePs(psTxt)
      const { bySession: herdrBySession, byCwd: herdrByCwd } = herdrTxt ? parseHerdrPanes(herdrTxt) : { bySession: new Map(), byCwd: new Map() }

      let activeOttyPane = ""
      if (ottyTxt) {
        try {
          const i = ottyTxt.indexOf("{")
          if (i >= 0) {
            const data = JSON.parse(ottyTxt.slice(i))?.data || []
            activeOttyPane = data.find((x) => x.active && x.process)?.id || data[0]?.id || ""
          }
        } catch {}
      }

      let tmuxByTty = new Map()
      const hasTmuxProc = [...procs.values()].some((p) => /\btmux\b/.test(p.comm) || /\btmux\b/.test(p.args))
      if (hasTmuxProc && existsSync(tmuxBin)) {
        const [panesTxt, clientsTxt] = await Promise.all([
          runAsync(tmuxBin, ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_tty}\t#{session_name}\t#{window_index}"], 1000),
          runAsync(tmuxBin, ["list-clients", "-F", "#{client_tty}\t#{client_pid}\t#{session_name}"], 1000),
        ])
        tmuxByTty = parseTmuxPanes(panesTxt, clientsTxt)
      }

      const herdrHosts = []
      const seen = new Set()
      for (const p of procs.values()) {
        if ((p.comm === "herdr" || p.comm.endsWith("/herdr")) && !/\b(server|pane|agent|workspace|tab)\b/.test(p.args)) {
          const w = walkAncestors(p.pid, procs)
          if (w.app && !seen.has(w.app.id)) {
            seen.add(w.app.id)
            herdrHosts.push({ id: w.app.id, app: w.app.app, label: w.app.app, bundleId: w.app.bundleId, ottyPane: w.app.id === "otty" ? activeOttyPane : "", tty: w.tty })
          }
        }
      }
      herdrHosts.sort((a, b) => (a.id === preferredHost ? -1 : b.id === preferredHost ? 1 : 0))

      const st = {
        platform: process.platform,
        liveFiles: readLiveFiles(),
        desktopIdx: readDesktopIndex(now),
        procs,
        herdrBySession,
        herdrByCwd,
        herdrHosts,
        tmuxByTty,
      }
      snap = { at: Date.now(), state: st, inflight: null }
      onUpdate?.()
      return st
    })()
    return snap.inflight
  }

  function resolve(s, now = Date.now(), preferredHost = "herdr-app") {
    if (!s) return null
    if (opts.state) return resolveTarget(s, opts.state)
    if (!snap.state || now - snap.at >= ttl) void refreshState(now, preferredHost)
    if (!snap.state) return null
    const st = { ...snap.state, liveFiles: readLiveFiles(), desktopIdx: readDesktopIndex(now) }
    return resolveTarget(s, st)
  }

  function decorate(sessions, now = Date.now(), preferredHost = "herdr-app") {
    if (!opts.state && (!snap.state || now - snap.at >= ttl)) void refreshState(now, preferredHost)
    if (!Array.isArray(sessions) || !sessions.length) return sessions
    const baseState = opts.state || snap.state
    if (!baseState) return sessions
    const st = opts.state ? baseState : { ...baseState, liveFiles: readLiveFiles(), desktopIdx: readDesktopIndex(now) }
    for (const s of sessions) {
      const t = resolveTarget(s, st)
      if (t) s.target = t
    }
    return sessions
  }

  async function jump(req, dryRun = false) {
    const st = opts.state || (await refreshState(Date.now(), req?.preferredHostId || "herdr-app"))
    const plan = buildJumpPlan(req, st)
    if (!plan.ok || dryRun) return plan
    for (const step of plan.steps) await runAsync(step.cmd, step.args, 2000)
    return { ...plan, executed: true }
  }

  return { resolve, decorate, jump, refreshState }
}
