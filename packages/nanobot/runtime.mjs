import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { pathsFor, reconcile, inspect } from "./bridge.mjs"

function configFile(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid-adapter-settings")
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-adapter-settings")
    return value
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw new Error("invalid-adapter-settings")
  }
}

export function resolvePaths(options = {}) {
  const defaults = pathsFor()
  const settings = { ...configFile(path.join(defaults.directory, "adapter.json")), ...options }
  if (settings.configPath !== undefined && (typeof settings.configPath !== "string" || !path.isAbsolute(settings.configPath))) throw new Error("configPath-must-be-absolute")
  return pathsFor({ configPath: settings.configPath })
}

function signature(p) {
  const hash = createHash("sha256")
  for (const file of [p.control, p.mcp]) {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid-control-file")
      hash.update(fs.readFileSync(file))
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      hash.update("<missing>")
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}

function claimRuntime(p) {
  const file = path.join(p.directory, "runtime.lock")
  fs.mkdirSync(p.directory, { recursive: true, mode: 0o700 })
  const owner = { pid: process.pid, nonce: randomUUID() }
  const readOwner = () => {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("invalid-runtime-lock")
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== "string") throw new Error("invalid-runtime-lock")
    return value
  }
  try { fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600, flag: "wx" }) }
  catch (error) {
    if (error.code !== "EEXIST") throw error
    const previous = readOwner()
    try { process.kill(previous.pid, 0); return null }
    catch (probe) { if (probe.code !== "ESRCH") return null }
    // Serialize stale reclamation separately. Re-reading a nonce alone is not
    // a compare-and-delete: another reclaimer could create a live lock between
    // the read and unlink. A leftover guard fails closed for manual inspection.
    const guard = file + ".reclaim"
    try { fs.writeFileSync(guard, owner.nonce, { mode: 0o600, flag: "wx" }) }
    catch (guardError) { if (guardError.code === "EEXIST") return null; throw guardError }
    try {
      let current
      try { current = readOwner() } catch (probe) { if (probe.code !== "ENOENT") throw probe }
      if (current) {
        try { process.kill(current.pid, 0); return null }
        catch (probe) { if (probe.code !== "ESRCH") return null }
        fs.unlinkSync(file)
      }
      try { fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600, flag: "wx" }) }
      catch (retry) { if (retry.code === "EEXIST") return null; throw retry }
    } finally {
      if (fs.readFileSync(guard, "utf8") === owner.nonce) fs.unlinkSync(guard)
    }
  }
  const release = () => {
    try { if (readOwner().nonce === owner.nonce) fs.unlinkSync(file) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  release.owns = () => { try { return readOwner().nonce === owner.nonce } catch { return false } }
  return release
}

// No backend request or nanobot process starts here. Each input must remain
// stable for one complete polling period before a target write is attempted.
export function startRuntime(p, { interval = 750, onStatus = () => {}, schedule = setInterval, cancel = clearInterval } = {}) {
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error("invalid-poll-interval")
  let previous = null, lastStatus = "", stopped = false, release = null
  const report = (status) => {
    const value = JSON.stringify(status)
    if (value !== lastStatus) { lastStatus = value; onStatus(status) }
    return status
  }
  const tick = () => {
    if (stopped) return
    try {
      if (release && !release.owns()) release = null
      if (!release) {
        release = claimRuntime(p)
        if (!release) return report({ state: "standby", recoveryPending: false, message: "Another Magpie host owns this adapter." })
      }
      const current = signature(p)
      if (current !== previous) { previous = current; return }
      return report(reconcile(p))
    } catch {
      return report({ state: "conflict", recoveryPending: true, message: "Adapter paused; inspect the control files and recovery status. Configuration contents are omitted." })
    }
  }
  const timer = schedule(tick, interval)
  timer.unref?.()
  return {
    tick,
    status: () => inspect(p),
    stop({ restore = true } = {}) {
      if (stopped) return
      stopped = true
      cancel(timer)
      // A normal shared-host exit cannot await RPC. Return only fields this
      // bridge still owns; retain desired inputs for a later host instance.
      if (!release) return
      try { return restore && release.owns() ? report(reconcile(p, { restore: true })) : undefined }
      finally { release(); release = null }
    },
  }
}
