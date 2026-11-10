// Both bounded generations belong to the rolling sample window. Cache by
// inode as well as size/mtime so a rename cannot masquerade as an append.
import { readFile, stat } from "node:fs/promises"

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export function createToolsReader(file, { now = Date.now } = {}) {
  const files = [file + ".1", file]
  let key = ""
  let rows = []
  let reading
  async function signature() {
    return (await Promise.all(files.map(async (path) => {
      try { const s = await stat(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
      catch (error) { if (error.code === "ENOENT") return "missing"; throw error }
    }))).join("|")
  }
  async function refresh() {
    if (reading) return reading
    reading = (async () => {
      // Retention advances even if neither file has changed.
      rows = rows.filter((r) => r.t >= now() - MAX_AGE_MS)
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await signature()
        if (before === key) return
        const texts = await Promise.all(files.map(async (path) => {
          try { return await readFile(path, "utf8") }
          catch (error) { if (error.code === "ENOENT") return ""; throw error }
        }))
        // Retry a rotation/append during the read rather than publish duplicate
        // generations or a missing history. Under sustained writes retry later.
        if (before !== await signature()) continue
        const out = []
        for (const text of texts) {
          const lines = text.split("\n")
          lines.pop() // only complete, newline-terminated records
          for (const line of lines) {
            try {
              const r = JSON.parse(line)
              if (Number.isFinite(r?.t) && r.t >= now() - MAX_AGE_MS && r.agent) out.push(r)
            } catch { /* malformed line */ }
          }
        }
        rows = out
        key = before
        return
      }
    })().finally(() => { reading = null })
    return reading
  }
  return { refresh, rows: () => rows, file }
}
