// Agent Lens — the local service. magpie's plugin page is sandboxed with
// connect-src 'none' and cannot fetch anything, so the page navigates its
// frame here, and this serves the real interface and the data behind it.
//
//   GET /              the interface (app/)
//   GET /api/summary   ?period=today|7d|30d&clients=1&tz=<minutes>
//   GET /api/health
//
// Loopback only: the data is the user's own usage.
import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { toolsLog, usageLog } from "./lib/paths.mjs"
import { createToolsReader } from "./lib/tools.mjs"
import { createUsageReader } from "./lib/usage.mjs"
import { PERIODS, summarize } from "./lib/summarize.mjs"
import { createBrands } from "./lib/brands.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, "app")
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
}

// Guards, as magpie's chat page does them. The page frame is sandboxed, so its
// Origin is the literal "null" — and so is any other site's sandboxed frame.
// Origin alone proves nothing, so every /api/ route also needs a token that
// lives only in this process and is written into the interface's HTML when
// this service serves it (that HTML carries no CORS header, so no other page
// can read it). Host must be this service itself, against DNS rebinding.
export const TOKEN_HEADER = "x-agent-lens-token"

export function createHandler(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : 3492
  const token = options.token || randomBytes(32).toString("hex")
  const own = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const hostOK = (req) => hosts.has(String(req.headers.host || "").toLowerCase())
  const originOK = (req) => { const o = req.headers.origin; return o === undefined || o === "null" || own.has(o) }
  const tokenOK = (req) => {
    // a query param, not only a header: a custom header makes the sandboxed
    // frame's fetch a preflighted request, which Chrome's private-network
    // checks block from an opaque origin; a plain GET goes through
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("k")
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || q || ""))
    const want = Buffer.from(token)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  const usage = createUsageReader(usageLog(options))
  const tools = createToolsReader(toolsLog(options))
  const brands = createBrands(options)

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "no-referrer")
    if (!hostOK(req) || !originOK(req)) return text(res, 403, "Agent Lens only serves its own page in magpie")
    // after the sandboxed frame navigates here its origin is opaque ("null"), so
    // even its own module script is cross-origin: allow that, nothing else
    const cors = () => { if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin === "null" ? "null" : req.headers.origin) }
    if (req.method === "OPTIONS") {
      cors()
      res.setHeader("Access-Control-Allow-Headers", TOKEN_HEADER)
      res.setHeader("Access-Control-Allow-Private-Network", "true")
      res.writeHead(204); return res.end()
    }
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "method not allowed")
    try {
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && !tokenOK(req)) {
        cors()
        // the service restarted and the token changed: the page reloads once
        return json(res, 403, { error: "stale token", reload: true })
      }
      if (url.pathname === "/api/summary") {
        await Promise.all([usage.refresh(), tools.refresh(), brands.refresh()])
        const period = PERIODS[url.searchParams.get("period")] ? url.searchParams.get("period") : "7d"
        const tz = Number(url.searchParams.get("tz"))
        const body = summarize({
          usage: usage.rows(), tools: tools.rows(), period,
          showClients: url.searchParams.get("clients") === "1",
          tzOffsetMin: Number.isFinite(tz) ? tz : 0,
          nameOf: (a) => brands.of(a).name,
        })
        for (const a of body.agents) {
          const b = brands.of(a.agent)
          Object.assign(a, { name: b.name, icon: await brands.dataUri(b.icon) })
        }
        body.sources = { usageLog: usage.file, toolsLog: tools.file, usageRows: usage.rows().length, toolRows: tools.rows().length }
        cors()
        return json(res, 200, body)
      }
      if (url.pathname === "/api/health") {
        return json(res, 200, { ok: true, service: "agent-lens" })
      }
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1))
      const full = normalize(join(APP, rel))
      if (!full.startsWith(APP + sep)) return text(res, 400, "bad path")
      const content = await readFile(full).catch(() => null)
      if (!content) return text(res, 404, "not found")
      const ext = full.slice(full.lastIndexOf("."))
      if (full === join(APP, "index.html")) {
        // the token goes into the HTML, which gets no CORS header
        const html = content.toString("utf8").replace("<head>", `<head>\n<meta name="agent-lens-token" content="${token}">`)
        res.writeHead(200, { "Content-Type": MIME[".html"] })
        return res.end(html)
      }
      cors()
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
      res.end(content)
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) })
    }
  }
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}
function text(res, code, body) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" })
  res.end(body)
}

// Start listening. A port still held by a previous host is retried in the
// background instead of failing the host's start.
export function serve(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : 3492
  const server = createServer(createHandler({ ...options, port }))
  const ready = new Promise((resolve) => {
    let tries = 0
    const attempt = () => server.listen(port, "127.0.0.1")
    server.on("listening", () => resolve(port))
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE" && tries++ < 30) setTimeout(attempt, 2000)
      else { console.error("[agent-lens] could not listen:", e.message); resolve(null) }
    })
    attempt()
  })
  return { server, port, ready }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = serve({ port: process.env.AGENT_LENS_PORT })
  s.ready.then((p) => p && console.log(`agent-lens on http://127.0.0.1:${p}/`))
}
