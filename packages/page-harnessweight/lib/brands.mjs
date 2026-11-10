// Each agent's display name and icon, exactly as magpie shows them. magpie's
// gateway already knows both: GET /v1/magpie/usage lists every agent with a
// name ("Claude Code") and an icon key ("claudecode-color"). The icon files
// live in app/icons/, named by that key; a key with no file falls back to the
// agent's initial in the page.
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "icons")
const TTL_MS = 10 * 60e3

export function gatewayUrl(options = {}) {
  const explicit = options.gatewayUrl || process.env.MAGPIE_GATEWAY_URL
  if (explicit) return String(explicit).trim().replace(/\/+$/, "")
  // MAGPIE_ADDR is the host's host:port, not a URL. Only wildcard bind
  // addresses become IPv4 loopback; an explicit IPv6 listener stays IPv6.
  const addr = String(process.env.MAGPIE_ADDR || "").trim().replace(/^(0\.0\.0\.0|\[::\])(:|$)/, "127.0.0.1$2")
  if (/^(\[[0-9a-f:.]+\]|[\w.-]+):\d+$/i.test(addr)) return `http://${addr}`
  return "http://127.0.0.1:3425"
}

export function createBrands(options = {}, fetchImpl = globalThis.fetch) {
  let at = 0
  let map = new Map()
  let files = null
  let pending = null

  async function iconFiles() {
    if (!files) {
      files = new Map()
      for (const f of await readdir(ICONS).catch(() => [])) {
        const dot = f.lastIndexOf(".")
        if (dot > 0 && /\.(svg|png|webp)$/i.test(f)) files.set(f.slice(0, dot), f)
      }
    }
    return files
  }

  async function refresh() {
    if (Date.now() - at < TTL_MS) return
    if (pending) return pending
    pending = (async () => {
      const have = await iconFiles()
      try {
        const res = await fetchImpl(`${gatewayUrl(options)}/v1/magpie/usage?period=30d`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        const next = new Map()
        for (const g of body.agents || []) {
          if (!g || !g.id) continue
          const key = typeof g.icon === "string" && g.icon !== "generic" ? g.icon : ""
          next.set(String(g.id), { name: String(g.name || g.id), icon: have.get(key) || null })
        }
        map = next
      } catch {
        // the gateway is down or older: keep what we had, retry sooner
        at = Date.now() - TTL_MS + 30e3
        return
      }
      at = Date.now()
    })().finally(() => { pending = null })
    return pending
  }

  // the brand for an agent id: magpie's, else the id itself and an icon file
  // whose name is the id, else no icon
  function of(agent) {
    const b = map.get(agent)
    if (b) return b
    const f = files?.get(String(agent).toLowerCase()) || files?.get(`${String(agent).toLowerCase()}-color`)
    return { name: agent, icon: f || null }
  }

  // an icon as a data: URI, so the page needs no request for it (in magpie's
  // sandboxed frame, images the script adds after load do not show)
  const uris = new Map()
  const TYPES = { svg: "image/svg+xml", png: "image/png", webp: "image/webp" }
  async function dataUri(file) {
    if (!file) return null
    if (!uris.has(file)) {
      const buf = await readFile(join(ICONS, file)).catch(() => null)
      const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase()
      uris.set(file, buf ? `data:${TYPES[ext]};base64,${buf.toString("base64")}` : null)
    }
    return uris.get(file)
  }

  return { refresh, of, dataUri }
}
