// Reads the tool-weight samples the gateway hook writes. The file is small
// (the hook keeps it to a rolling window), so it is read whole, cached by
// its size and modification time.
import { readFile, stat } from "node:fs/promises"

export function createToolsReader(file) {
  let key = ""
  let rows = []
  async function refresh() {
    let st
    try { st = await stat(file) } catch { rows = []; key = ""; return }
    const k = `${st.size}:${st.mtimeMs}`
    if (k === key) return
    const text = await readFile(file, "utf8").catch(() => "")
    const out = []
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const r = JSON.parse(line)
        if (typeof r.t === "number" && r.agent) out.push(r)
      } catch { /* half-written line */ }
    }
    rows = out
    key = k
  }
  return { refresh, rows: () => rows, file }
}
