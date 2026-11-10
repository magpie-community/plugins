// 页面服务：给窗口里的“模型剩余额度”页提供 /api/report，并托管 ui/。
//
// 数据全部来自本机 magpie 的配置目录：
//   usage.jsonl        逐条请求的 token
//   quota-history.json 每个账号每个窗口的剩余百分比读数
//   quotas.json        当前额度快照（网关不可用时的兜底）
// 当前额度优先问网关 GET /v1/magpie/quotas?kept=1，那里带 remaining 与 holds。

import { createServer } from "node:http"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { readFileSync, openSync, readSync, closeSync, statSync } from "node:fs"
import { join, extname, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"
import { buildReport, indexUsage } from "./report.mjs"

const here = fileURLToPath(new URL(".", import.meta.url))
const UI_ROOT = join(here, "..", "ui")
const THIS_FILE = fileURLToPath(import.meta.url)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
}

// magpie 的配置目录：便携安装时宿主以配置目录为 cwd 启动服务，所以先看 cwd；
// 其次 XDG_CONFIG_HOME，最后 ~/.config/magpie。MAGPIE_CONFIG_DIR 只作显式覆盖。
let CONFIG_OVERRIDE = ""
export function configDir() {
  if (CONFIG_OVERRIDE) return CONFIG_OVERRIDE
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR
  try {
    const cwd = process.cwd()
    for (const f of ["usage.jsonl", "plugins.json", "providers.json"]) {
      if (existsSync(join(cwd, f))) return cwd
    }
  } catch {}
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, "magpie")
  return join(os.homedir(), ".config", "magpie")
}

const gatewayBase = () => {
  let a = process.env.MAGPIE_ADDR || process.env.MAGPIE_GATEWAY || "127.0.0.1:3425"
  if (!/^https?:\/\//i.test(a)) a = "http://" + a
  try {
    return new URL(a).origin
  } catch {
    return "http://127.0.0.1:3425"
  }
}
const GATEWAY = gatewayBase

// ---- 数据装载 ---------------------------------------------------------------

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

// 一次读完整份 usage.jsonl，并把字节偏移记下来，之后只读追加的部分。
function openUsage(file) {
  const state = { file, offset: 0, rows: [], shrank: false }
  reloadUsage(state)
  return state
}

function reloadUsage(state) {
  state.rows = []
  state.offset = 0
  if (!existsSync(state.file)) return
  const size = statSync(state.file).size
  const fd = openSync(state.file, "r")
  try {
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, 0)
    state.offset = size
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue
      try { state.rows.push(JSON.parse(line)) } catch { /* 尾行未写完时跳过 */ }
    }
  } finally {
    closeSync(fd)
  }
}

function appendUsage(state) {
  if (!existsSync(state.file)) return
  const size = statSync(state.file).size
  if (size < state.offset) { reloadUsage(state); return }
  if (size === state.offset) return
  const fd = openSync(state.file, "r")
  try {
    const len = size - state.offset
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, state.offset)
    const text = buf.toString("utf8")
    const lastNl = text.lastIndexOf("\n")
    // 只吸收已经完整成行的部分，剩下的半行下次再读
    const usable = lastNl >= 0 ? text.slice(0, lastNl) : ""
    if (usable) {
      for (const line of usable.split("\n")) {
        if (!line.trim()) continue
        try { state.rows.push(JSON.parse(line)) } catch { /* 理论上不会发生 */ }
      }
      state.offset += Buffer.byteLength(usable, "utf8") + 1
    }
  } finally {
    closeSync(fd)
  }
}

async function gatewayQuotas() {
  const res = await fetch(`${GATEWAY()}/v1/magpie/quotas?kept=1`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error("网关额度接口 HTTP " + res.status)
  const body = await res.json()
  return body.data ?? []
}

// quotas.json 兜底：它只有 used，没有 remaining / holds，但足够算百分比。
function fileQuotas() {
  const raw = readJsonSafe(join(configDir(), "quotas.json"), {})
  const out = []
  for (const rec of Object.values(raw)) {
    const q = rec?.quota
    if (!q || !Array.isArray(q.windows)) continue
    out.push({
      provider: q.provider,
      name: q.name,
      plan: q.plan,
      user: q.user,
      windows: q.windows.map((w) => ({
        ...w,
        remaining: typeof w.remaining === "number" ? w.remaining : Math.max(0, 100 - Number(w.used || 0)),
      })),
    })
  }
  return out
}

// ---- 报告缓存 ---------------------------------------------------------------

export function createEngine() {
  const dir = configDir()
  const usage = openUsage(join(dir, "usage.jsonl"))
  let cache = null
  let building = null
  let lastBuild = 0
  const MAX_AGE = 30 * 1000

  async function build(force) {
    if (!force && cache && Date.now() - lastBuild < MAX_AGE) return cache
    if (building) return building
    building = (async () => {
      appendUsage(usage)
      let quotaRecords
      let source = "gateway"
      let sourceError = ""
      try {
        quotaRecords = await gatewayQuotas()
      } catch (e) {
        quotaRecords = fileQuotas()
        source = "file"
        sourceError = String(e?.message || e)
      }
      const history = readJsonSafe(join(dir, "quota-history.json"), {})
      const idx = indexUsage(usage.rows, { now: Date.now() })
      const report = buildReport({ quotaRecords, history, usage: idx, now: Date.now() })
      report.source = source
      report.sourceError = sourceError
      report.usageRows = usage.rows.length
      cache = report
      lastBuild = Date.now()
      return report
    })().finally(() => { building = null })
    return building
  }

  return { build, usage }
}

// ---- HTTP -------------------------------------------------------------------

const DEFAULT_PORT = 3496
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) } catch { return {} }
})()
const BUILD_ID = createHash("sha1").update(readFileSync(THIS_FILE)).update(String(PKG.version || "")).digest("hex").slice(0, 10)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// port: 页面服务的端口，未给则用 DEFAULT_PORT。configDir: magpie 的配置目录。
export async function startServer({ port, configDir: given } = {}) {
  // magpie 在 input.directory 里给出配置目录，便携安装时比 cwd 探测更可靠。
  CONFIG_OVERRIDE = given && existsSync(join(given, "usage.jsonl")) ? given : ""
  const engine = createEngine()
  // 页面口令：每次启动重新生成，注入到本实例返回的 HTML，不落盘。
  const KEY = randomBytes(24).toString("base64url")
  let actualPort = 0
  let OWN = new Set()
  let HOSTS = new Set()

  const own = (p) => {
    actualPort = p
    OWN = new Set([`http://127.0.0.1:${p}`, `http://localhost:${p}`])
    HOSTS = new Set([`127.0.0.1:${p}`, `localhost:${p}`])
  }

  // Host 只认本进程实际监听端口上的 127.0.0.1 和 localhost，挡掉 DNS 重新绑定。
  const hostAllowed = (req) => HOSTS.has(String(req.headers.host || "").toLowerCase())
  // magpie 的插件页面在 sandbox="allow-scripts" 的框架里，导航后仍是 opaque origin，
  // 请求带的 Origin 就是字面量 "null"。允许它，但 API 一律要页面口令；其它来源拒绝。
  const originAllowed = (req) => {
    const o = req.headers.origin
    return o === undefined || o === "null" || OWN.has(o)
  }
  const corsHeaders = (req) => {
    const o = req.headers.origin
    const h = { vary: "Origin" }
    if (o === "null") h["access-control-allow-origin"] = "null"
    else if (o && OWN.has(o)) h["access-control-allow-origin"] = o
    return h
  }
  const send = (res, status, body, type = "application/json; charset=utf-8", withCors = true) => {
    const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      ...(withCors ? corsHeaders(res.req) : {}),
      "x-content-type-options": "nosniff",
    })
    res.end(data)
  }
  const keyOK = (req) => {
    const got = Buffer.from(String(req.headers["x-magpie-quota-key"] || ""))
    const want = Buffer.from(KEY)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1:" + (actualPort || DEFAULT_PORT))
    const pathname = url.pathname
    if (process.env.MAGPIE_QUOTA_DEBUG && pathname.startsWith("/api/")) {
      console.log(`[model-quota] ${req.method} ${pathname} host=${req.headers.host || "-"} origin=${req.headers.origin || "-"} key=${req.headers["x-magpie-quota-key"] ? "yes" : "no"}`)
    }
    if (!hostAllowed(req)) return send(res, 403, { error: "invalid host" }, undefined, false)
    if (!originAllowed(req)) return send(res, 403, { error: "cross-origin reads are not allowed" })
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(req),
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type, x-magpie-quota-key",
        "access-control-max-age": "86400",
      })
      return res.end()
    }
    try {
      if (pathname === "/api/ping") {
        return send(res, 200, { ok: true, service: "magpie-model-quota", build: BUILD_ID, port: actualPort })
      }
      if (pathname.startsWith("/api/")) {
        if (!keyOK(req)) return send(res, 401, { error: "unauthorized: send the x-magpie-quota-key header" })
        if (pathname === "/api/report") {
          const report = await engine.build(req.method === "POST")
          return send(res, 200, report)
        }
        return send(res, 404, { error: "not found" })
      }

      // 静态资源
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "")
      const file = join(UI_ROOT, rel)
      if (!file.startsWith(UI_ROOT)) return send(res, 403, { error: "forbidden" }, undefined, false)
      const data = await readFile(file).catch(() => null)
      if (!data) return send(res, 404, "not found", "text/plain; charset=utf-8", false)
      const type = MIME[extname(file).toLowerCase()] || "application/octet-stream"
      if (rel === "index.html") {
        // 只把注入了口令的 HTML 交给“导航”；跨源 fetch 拿不到它，也就拿不到口令。
        const mode = String(req.headers["sec-fetch-mode"] || "")
        if (mode && mode !== "navigate") return send(res, 403, { error: "cross-origin page read not allowed" }, undefined, false)
        const html = data.toString("utf8").replace("<head>", `<head>\n<meta name="magpie-quota-key" content="${KEY}">`)
        return send(res, 200, html, type, false)
      }
      return send(res, 200, data, type, false)
    } catch (err) {
      if (res.headersSent) { try { res.end() } catch {} return }
      return send(res, 500, { error: String(err?.message || err) })
    }
  })

  // 端口：调用方给的值 → 环境变量 → 默认 3496。页面从同一份 options 读，保证一致。
  const rawWant = port ?? process.env.MAGPIE_MODEL_QUOTA_PORT
  let target = DEFAULT_PORT
  if (rawWant !== undefined && rawWant !== null && rawWant !== "" && Number.isFinite(Number(rawWant))) {
    const n = Number(rawWant)
    if (Number.isInteger(n) && n >= 0 && n <= 65535) target = n
  }

  const probe = async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) })
      if (!r.ok) return null
      const j = await r.json()
      return j && j.service === "magpie-model-quota" ? j : null
    } catch {
      return null
    }
  }

  const bindOnce = (p) => new Promise((resolve, reject) => {
    const cleanup = () => { server.removeListener("listening", onOk); server.removeListener("error", onErr) }
    const onOk = () => { cleanup(); own(server.address().port); resolve(true) }
    const onErr = (e) => {
      cleanup()
      // 端口被占/无权限 → 交给上层重试；其它错误直接失败
      if (e.code !== "EADDRINUSE" && e.code !== "EACCES") reject(e)
      else resolve(false)
    }
    server.once("listening", onOk)
    server.once("error", onErr)
    server.listen(p, "127.0.0.1")
  })

  // 旧实例（上一个版本或上一个宿主）还占着端口时，先复用它，保证 magpie 能在
  // 它自己的 20 秒加载窗口内成功；同时后台等它退出，再由新实例接管同一个端口。
  const takeover = (p) => {
    ;(async () => {
      for (;;) {
        await sleep(1000)
        try {
          if (await bindOnce(p)) {
            console.log(`[model-quota] took over ${p} with build ${BUILD_ID}`)
            return
          }
        } catch (e) {
          console.log(`[model-quota] takeover failed: ${e.code || e.message}`)
          return
        }
      }
    })()
  }
  const reused = (p) => ({ port: p, listening: false, reused: true, server, close: async () => { if (server.listening) server.close() } })

  const deadline = Date.now() + 20000
  let foreignSince = 0
  for (;;) {
    if (await bindOnce(target)) break
    const st = await probe(target)
    if (st) {
      if (st.build === BUILD_ID) {
        // 濒死实例也能应答一次；1.5 秒后仍活着才复用
        await sleep(1500)
        const again = await probe(target)
        if (again && again.build === BUILD_ID) {
          own(target)
          console.log(`[model-quota] ${target} already served by the same build, reusing it`)
          takeover(target)
          return reused(target)
        }
        continue
      }
      own(target)
      console.log(`[model-quota] ${target} is served by build ${st.build}; reusing it until it exits`)
      takeover(target)
      return reused(target)
    }
    // 端口上没有我们的服务：可能是别的程序，短暂重试后直接报错
    if (!foreignSince) foreignSince = Date.now()
    if (Date.now() - foreignSince > 4000) {
      throw new Error(`port ${target} is in use by another program — free it or set the plugin's port option`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`port ${target} is not available — free it or set the plugin's port option`)
    }
    await sleep(150)
  }

  console.log(`[model-quota] listening on http://127.0.0.1:${actualPort}`)
  return { port: actualPort, listening: true, reused: false, server, close: async () => { if (server.listening) server.close() } }
}

