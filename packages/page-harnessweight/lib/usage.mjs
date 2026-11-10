// Reads magpie's usage ledger incrementally. The file is large (hundreds of
// MB) and only ever appended to, so the reader remembers how far it got and
// reads only what is new; when the file shrinks (rotated), it starts over.
import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { createInterface } from "node:readline"

// Rows older than this are not kept in memory: the page offers 30 days.
export const KEEP_MS = 31 * 24 * 60 * 60 * 1000

// Clients that are scripts, SDKs or magpie's own probes rather than agents a
// person works in. They are hidden by default and can be shown.
const CLIENTS = new Set([
  "gateway-probe", "python-urllib", "curl", "go-http-client", "openai", "node",
  "asyncopenai", "bun", "anthropic", "magpie", "ai", "vercel-ai", "langchain", "litellm", "axios", "python-requests", "httpx", "wget",
])
export function kindOf(agent) {
  const a = String(agent || "").toLowerCase()
  if (!a || a === "unknown") return "client"
  if (CLIENTS.has(a) || a.startsWith("local-agent-mode")) return "client"
  return "agent"
}

// The request family, from magpie's endpoint note ("/v1/chat/completions → /v1/messages").
export function protocolOf(ep) {
  const e = String(ep || "")
  const last = e.split("→").pop()
  if (last.includes("streamGenerateContent") || last.includes("generateContent")) return "gemini"
  if (last.includes("/messages")) return "anthropic"
  if (last.includes("/responses")) return "responses"
  if (last.includes("/chat/completions")) return "chat"
  return "other"
}

// One ledger line → a compact row, or null when it is not a model request.
export function parseUsageLine(line) {
  let d
  try { d = JSON.parse(line) } catch { return null }
  if (!d || typeof d !== "object") return null
  const t = typeof d.t === "number" ? d.t : Date.parse(d.t)
  if (!Number.isFinite(t)) return null
  const status = Number(d.status) || 0
  const cancelled = status === 499
  const failed = !cancelled && (status === 0 || status >= 400 || Boolean(d.err))
  return {
    t,
    agent: intern(String(d.agent || "unknown")),
    // the conversation this request belongs to; harnesses that keep a session
    // id let us measure how long one session actually lasts
    session: d.session ? intern(String(d.session)) : "",
    model: intern(String(d.model || "unknown")),
    protocol: protocolOf(d.ep),
    in: num(d.in), out: num(d.out),
    cacheRead: num(d.cache_read), cacheWrite: num(d.cache_write),
    credits: num(d.credits),
    ms: num(d.ms), ttft: num(d.ttft_ms),
    failed, cancelled,
  }
}

// Ledger strings repeat endlessly (a few agents, a few dozen models): keep one copy.
const pool = new Map()
function intern(s) {
  let v = pool.get(s)
  if (v === undefined) { v = s; pool.set(s, s) }
  return v
}

function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : 0 }

export function createUsageReader(file) {
  let offset = 0
  let rows = []
  let reading = null

  async function refresh() {
    if (reading) return reading
    reading = (async () => {
      let st
      try { st = await stat(file) } catch { rows = []; offset = 0; return }
      if (st.size < offset) { rows = []; offset = 0 }
      if (st.size === offset) return
      // a last line still being written has no newline yet: stop before it
      const end = await lastNewline(file, offset, st.size)
      if (end < offset) return
      const cutoff = Date.now() - KEEP_MS
      const fresh = []
      const stream = createReadStream(file, { start: offset, end, encoding: "utf8" })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        const r = parseUsageLine(line)
        if (r && r.t >= cutoff) fresh.push(r)
      }
      offset = end + 1
      const keepFrom = Date.now() - KEEP_MS
      rows = rows.length && rows[0].t < keepFrom ? rows.filter((r) => r.t >= keepFrom) : rows
      for (const r of fresh) rows.push(r)
    })().finally(() => { reading = null })
    return reading
  }

  return { refresh, rows: () => rows, file }
}

// The position of the last newline in [from, size), or from-1 when none.
async function lastNewline(file, from, size) {
  const fh = await open(file, "r")
  try {
    const step = 64 * 1024
    let pos = size
    while (pos > from) {
      const start = Math.max(from, pos - step)
      const buf = Buffer.alloc(pos - start)
      await fh.read(buf, 0, buf.length, start)
      const i = buf.lastIndexOf(10)
      if (i >= 0) return start + i
      pos = start
    }
    return from - 1
  } finally {
    await fh.close()
  }
}
