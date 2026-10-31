#!/usr/bin/env node
// Agent Office without magpie: one Bun process reads the same session files,
// serves the same page on 127.0.0.1, and prints the same snapshot as JSON.
//
//   bun bin/agent-office.mjs                 open the office
//   bun bin/agent-office.mjs --json          one snapshot, then exit
//   bun bin/agent-office.mjs --private       statuses and tool names only
//   bun bin/agent-office.mjs --hours 6       only the last 6 hours
//
// The magpie plugin is still the main path: no port, no server. This is for a
// terminal, a skill, or a machine where magpie is not open.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const PAGE = join(here, "page")
const VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version

const HELP = `Agent Office ${VERSION}
A live office for the coding agents on this computer.

Usage: bun bin/agent-office.mjs [options]

  -p, --port <n>   port (default 4545, next free one if taken)
  --hours <n>      sessions active in the last n hours (default 48)
  --private        hide prompts, replies and titles; status only
  --json           print one snapshot as JSON and exit
  --no-open        don't open the browser
  -h, --help
  -v, --version

The magpie plugin is the normal install. This CLI serves the same page when
magpie is not running. It binds to 127.0.0.1 only and never writes a session.
`

function usage(msg) {
  if (msg) console.error(msg + "\n")
  console.error(HELP)
  process.exit(msg ? 1 : 0)
}

function args(argv) {
  const o = { port: 4545, hours: 48, private: false, json: false, open: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") usage()
    else if (a === "-v" || a === "--version") { console.log(VERSION); process.exit(0) }
    else if (a === "-p" || a === "--port") o.port = Number(argv[++i])
    else if (a.startsWith("--port=")) o.port = Number(a.slice(7))
    else if (a === "--hours") o.hours = Number(argv[++i])
    else if (a.startsWith("--hours=")) o.hours = Number(a.slice(8))
    else if (a === "--private") o.private = true
    else if (a === "--json") o.json = true
    else if (a === "--no-open") o.open = false
    else usage(`Unknown option: ${a}`)
  }
  if (!Number.isFinite(o.port) || o.port < 0) usage("--port must be a number")
  if (!Number.isFinite(o.hours) || o.hours <= 0) usage("--hours must be positive")
  return o
}

const o = args(process.argv.slice(2))
// the scanner takes days; keep an hour window exact instead of rounding up
const days = Math.max(1 / 24, o.hours / 24)
// the plugin writes live.js beside the page; in CLI mode it goes to a temp
// folder and the server answers /live.js from the snapshot instead
const scratch = mkdtempSync(join(tmpdir(), "agent-office-cli-"))
process.env.MAGPIE_AGENT_OFFICE_PAGE = scratch

const hook = await import("../office.hooks.mjs")
const startOpts = { text: !o.private, scanner: { days, max: 200 } }
hook.start(startOpts)
await new Promise((r) => setTimeout(r, 250))
const first = hook.snapshot()

if (o.json) {
  hook.stop()
  rmSync(scratch, { recursive: true, force: true })
  console.log(JSON.stringify(first, null, 2))
  process.exit(0)
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

const options = { ...startOpts, remote: false }
const enc = new TextEncoder()

function json(v, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })
}

function bridge() {
  return `(() => {
  const options = ${JSON.stringify(options)}
  const theme = { dark: true, lang: ${JSON.stringify("en")}, tokens: { bg: "#0b0c10", fg: "#f4f4f5", card: "#14151b", line: "#2a2c35", muted: "#9ca3af" } }
  globalThis.magpie = { ready: Promise.resolve(theme), theme, context: {}, onTheme() {}, onAction() {},
    options: {
      get: async () => options,
      set: async (next) => { const r = await fetch("/api/options", { method: "POST", body: JSON.stringify(next) }); return r.json(); },
    },
    read: async (n) => { throw new Error("no read " + n) } }
})()`
}

function pagePolicy(host) {
  const own = "http://" + host
  return [
    "default-src 'none'",
    `script-src ${own}; style-src ${own} 'unsafe-inline'; img-src ${own} data:; font-src ${own}; media-src ${own}`,
    "connect-src 'self'",
    "frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
  ].join("; ")
}

function live() {
  return "globalThis.AgentOfficeLive = " + JSON.stringify(hook.snapshot()) + ";\n"
}

function safePath(rel) {
  const p = normalize(join(PAGE, rel))
  return p === PAGE || p.startsWith(PAGE + sep) ? p : ""
}

function serveStatic(req, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"
  if (rel === "live.js") {
    return new Response(live(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })
  }
  if (rel === "_magpie/bridge.js") {
    return new Response(bridge(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })
  }
  const file = safePath(rel)
  if (!file) return new Response("forbidden", { status: 403 })
  try {
    if (!statSync(file).isFile()) return new Response("not found", { status: 404 })
    return new Response(readFileSync(file), {
      headers: { "content-type": types[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" },
    })
  } catch {
    return new Response("not found", { status: 404 })
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: o.port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/ping") return json({ name: "agent-office", version: VERSION })
    if (url.pathname === "/api/sessions") return json(hook.snapshot())
    if (url.pathname === "/api/options" && req.method === "GET") return json(options)
    if (url.pathname === "/api/options" && req.method === "POST") {
      return req.json().then((next) => {
        Object.assign(options, next || {})
        hook.start({ text: options.text !== false, remote: options.remote === true })
        return json(options)
      }).catch(() => json({ error: "bad json" }, 400))
    }
    const res = serveStatic(req, url)
    res.headers.set("content-security-policy", pagePolicy(req.headers.get("host") || `127.0.0.1:${server.port}`))
    res.headers.set("x-content-type-options", "nosniff")
    res.headers.set("cache-control", "no-store")
    return res
  },
})

const address = `http://127.0.0.1:${server.port}/`
console.log(`Agent Office ${VERSION} — ${first.sessions.length} session${first.sessions.length === 1 ? "" : "s"} — ${address}`)
if (o.open) {
  const [cmd, argv2] =
    process.platform === "darwin" ? ["open", [address]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", address]]
    : ["xdg-open", [address]]
  try { spawn(cmd, argv2, { stdio: "ignore", detached: true }).on("error", () => {}).unref() } catch {}
}

const close = () => { try { server.stop(true) } catch {} ; process.exit(0) }
process.on("SIGINT", close)
process.on("SIGTERM", close)
