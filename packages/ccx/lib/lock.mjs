import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// One Chrome profile must never be driven by two Magpie processes at once.
// The pid lets a later holder recover a lock left by a crashed process.
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    return undefined
  }
}

export async function abandoned(path) {
  let locked
  try { locked = (await stat(path)).mtimeMs } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  let pid
  try { pid = Number((await readFile(path, "utf8")).trim()) } catch { return Date.now() - locked > 10000 }
  if (!pid) return Date.now() - locked > 10000
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  const running = alive(pid)
  if (running === false) return true
  if (running === undefined) return Date.now() - locked > 10 * 60 * 1000
  if (process.platform === "linux") {
    try {
      const started = (await stat(`/proc/${pid}`)).mtimeMs
      return started > locked + 1000
    } catch {}
  }
  return Date.now() - locked > 15 * 60 * 1000
}

export async function take(file, { timeout = 180000, poll = 250, busy = "Another Magpie is still using this account's browser" } = {}) {
  const path = `${file}.lock`
  const deadline = Date.now() + timeout
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600)
      await handle.writeFile(String(process.pid))
      await rm(`${file}.want`, { force: true }).catch(() => {})
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close().catch(() => {})
        await writeFile(`${file}.since`, new Date().toISOString(), { mode: 0o600 }).catch(() => {})
        await rm(path, { force: true })
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const left = await abandoned(path)
      if (left === null) continue
      if (left) { await rm(path, { force: true }); continue }
      await writeFile(`${file}.want`, String(process.pid), { mode: 0o600 }).catch(() => {})
      if (Date.now() >= deadline) throw new Error(busy)
      await new Promise((resolve) => setTimeout(resolve, poll))
    }
  }
}

export async function wanted(file) {
  try { return (await stat(`${file}.want`)).mtimeMs } catch { return 0 }
}
