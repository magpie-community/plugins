import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const lifetime = 24 * 60 * 60_000
const directory = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "magpie", "factory-droid", "sessions")

// Each exact history is a single-use cursor. Claim it before advancing Droid.
export function takeCheckpoint(key) {
  if (!key) return
  const file = join(directory(), key + ".json")
  const claimed = file + "." + randomUUID()
  try {
    renameSync(file, claimed)
    const data = JSON.parse(readFileSync(claimed, "utf8"))
    if (Number.isSafeInteger(data.at) && Date.now() >= data.at && Date.now() - data.at < lifetime &&
        typeof data.id === "string" && typeof data.selection?.model === "string" &&
        ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"].every(f => Number.isSafeInteger(data.usage?.[f]) && data.usage[f] >= 0) &&
        /^magpie-factory-droid-[a-zA-Z0-9]{6}$/.test(data.dir) &&
        /^mp[0-9a-f]{8}$/.test(data.server) && /^[\w-]{1,128}$/.test(data.id)) return data
  } catch {} finally {
    try { unlinkSync(claimed) } catch {}
  }
}

export function saveCheckpoint(key, data) {
  if (!key || !data) return
  const dir = directory()
  const file = join(dir, key + ".json"), temp = file + "." + randomUUID()
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(temp, JSON.stringify({ ...data, at: Date.now() }), { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
    const recent = []
    for (const name of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36})?$/.test(name)) continue
      const path = join(dir, name)
      const st = statSync(path, { throwIfNoEntry: false })
      if (!st) continue
      if (Date.now() - st.mtimeMs >= lifetime) {
        try { unlinkSync(path) } catch {}
      } else if (name.endsWith(".json")) recent.push([path, st.mtimeMs])
    }
    for (const [path] of recent.sort((a, b) => b[1] - a[1]).slice(128)) {
      try { unlinkSync(path) } catch {}
    }
  } catch {} finally { try { unlinkSync(temp) } catch {} }
}
