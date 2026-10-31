#!/usr/bin/env bun
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
import { randomBytes } from "node:crypto"
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

  -p, --port <n>   port (default 4545; 0 chooses an available port)
  --hours <n>      sessions active in the last n hours (default 48)
  --private        hide prompts, replies and titles; status only
  --json           print one snapshot as JSON and exit
  --no-open        don't open the browser
  -h, --help
  -v, --version

The magpie plugin is the normal install. This CLI serves the same page when
magpie is not running. Requires Bun 1.2+; Node alone is not supported.
It binds to 127.0.0.1 only and never writes a session. An occupied port exits
with an error; use --port 0 for a separate server on an available port.
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
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) usage("--port must be an integer from 0 to 65535")
  if (!Number.isFinite(o.hours) || o.hours <= 0) usage("--hours must be positive")
  return o
}

const o = args(process.argv.slice(2))
if (typeof Bun === "undefined") {
  console.error("Agent Office requires Bun 1.2+. Run: bun bin/agent-office.mjs")
  process.exit(1)
}
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
// Keep the capability out of public routes: scripts loaded by another origin
// cannot discover it. All page-relative assets stay under this same prefix.
const prefix = "/" + randomBytes(32).toString("hex") + "/"

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
      set: async (next) => { const r = await fetch(${JSON.stringify(prefix + "api/options")}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }); if (!r.ok) throw new Error("Options update failed"); return r.json(); },
    },
    read: async (n) => { throw new Error("no read " + n) } }
})()`
}

function pagePolicy() {
  return [
    "default-src 'none'",
    "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
  ].join("; ")
}

function live() {
  return "globalThis.AgentOfficeLive = " + JSON.stringify(hook.snapshot()) + ";\n"
}

function safePath(rel) {
  const p = normalize(join(PAGE, rel))
  return p === PAGE || p.startsWith(PAGE + sep) ? p : ""
}

function serveStatic(pathname) {
  let rel
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html" }
  catch { return new Response("bad path", { status: 400 }) }
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

async function route(req) {
  const url = new URL(req.url)
  const host = req.headers.get("host")
  const allowed = [`127.0.0.1:${server.port}`, `localhost:${server.port}`]
  if (!allowed.includes(host) || url.host !== host) return json({ error: "invalid host" }, 403)
  // Also reject cross-site script loads even if a capability URL was shared.
  if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "cross-site request" }, 403)
  if (!url.pathname.startsWith(prefix)) return json({ error: "not found" }, 404)
  const path = url.pathname.slice(prefix.length)
  if (req.method === "POST") {
    if (req.headers.get("origin") !== `http://${host}`) return json({ error: "invalid origin" }, 403)
    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "application/json required" }, 415)
    }
    if (path !== "api/options") return json({ error: "not found" }, 404)
    let next
    try { next = await req.json() } catch { return json({ error: "bad json" }, 400) }
    if (!next || typeof next !== "object" || Array.isArray(next)) return json({ error: "expected options object" }, 400)
    if (("text" in next && typeof next.text !== "boolean") || ("remote" in next && typeof next.remote !== "boolean")) {
      return json({ error: "text and remote must be booleans" }, 400)
    }
    // UI preferences remain local to this bridge; never accept scanner paths or
    // other hook internals from a request body.
    for (const key of ["text", "remote", "mode", "dim", "demo", "showDone", "hideAfter", "scene", "quality", "agents", "showSub", "showIdle", "side", "sideV", "cleared", "approvalAfterSec", "lang"]) {
      if (Object.hasOwn(next, key)) options[key] = next[key]
    }
    hook.start({ text: options.text !== false, remote: options.remote === true })
    return json(options)
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405)
  if (path === "api/ping") return json({ name: "agent-office", version: VERSION })
  if (path === "api/sessions") return json(hook.snapshot())
  if (path === "api/options") return json(options)
  return serveStatic(path)
}

let server
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    async fetch(req) {
      const res = await route(req)
      res.headers.set("content-security-policy", pagePolicy())
      res.headers.set("x-content-type-options", "nosniff")
      res.headers.set("cross-origin-resource-policy", "same-origin")
      res.headers.set("referrer-policy", "no-referrer")
      res.headers.set("cache-control", "no-store")
      return res
    },
  })
} catch (err) {
  hook.stop()
  rmSync(scratch, { recursive: true, force: true })
  console.error(`Could not start Agent Office on port ${o.port}: ${err.code || err.message}. Use --port 0 or another port.`)
  process.exit(1)
}

const address = `http://127.0.0.1:${server.port}${prefix}`
console.log(`Agent Office ${VERSION} — ${first.sessions.length} session${first.sessions.length === 1 ? "" : "s"} — ${address}`)
if (o.open) {
  const [cmd, argv2] =
    process.platform === "darwin" ? ["open", [address]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", address]]
    : ["xdg-open", [address]]
  try { spawn(cmd, argv2, { stdio: "ignore", detached: true }).on("error", () => {}).unref() } catch {}
}

const close = () => {
  try { server.stop(true) } catch {}
  hook.stop()
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
