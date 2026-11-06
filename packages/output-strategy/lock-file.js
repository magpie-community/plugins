// Cross-process read-modify-write lock for stats.json. A heartbeat keeps an
// active holder from looking stale; an owner token prevents an old holder from
// releasing a newer holder's lock.
import { open, readFile, stat, unlink, utimes } from "node:fs/promises"
import { randomUUID } from "node:crypto"

const WAIT_MS = 2000
const STALE_MS = 15000
const HEARTBEAT_MS = 5000

export async function acquireLock(file, waitMs = WAIT_MS) {
  const lock = `${file}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const token = `${process.pid}:${randomUUID()}`
      const handle = await open(lock, "wx")
      await handle.write(token, "utf8")
      const heartbeat = setInterval(() => {
        void utimes(lock, new Date(), new Date()).catch(() => {})
      }, HEARTBEAT_MS)
      heartbeat.unref()
      return { lock, handle, token, heartbeat }
    } catch {
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > STALE_MS) await unlink(lock)
      } catch { /* The lock vanished or is unreadable: retry within the deadline. */ }
      if (Date.now() >= deadline) return null
      await new Promise(resolve => setTimeout(resolve, 15))
    }
  }
}

export async function assertLockOwner(held) {
  if (!held) throw new Error("stats lock not held")
  const owner = await readFile(held.lock, "utf8")
  if (owner !== held.token) throw new Error("stats lock ownership lost")
}

export async function releaseLock(held) {
  if (!held) return
  clearInterval(held.heartbeat)
  try { await held.handle.close() } catch {}
  try {
    if (await readFile(held.lock, "utf8") === held.token) await unlink(held.lock)
  } catch { /* Already gone or replaced: never delete another owner's lock. */ }
}
