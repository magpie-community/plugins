// The MCP subprocess and the ACP client share this session's private directory.
// Rename publishes a complete request/result, including large tool outputs.
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function publish(dir, name, value) {
  const file = join(dir, name)
  writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 })
  renameSync(file + ".tmp", file)
}

export function receiveToolCalls(dir, onCall, onError) {
  function accept(file) {
    const path = join(dir, file)
    const call = JSON.parse(readFileSync(path, "utf8"))
    unlinkSync(path)
    const id = file.slice(5)
    Promise.resolve().then(() => onCall(id, call)).then(result => {
      publish(dir, "result-" + id, result)
    }).catch(onError)
  }
  // Directory scans also see atomic renames coalesced by macOS file watchers.
  const timer = setInterval(() => {
    try {
      for (const file of readdirSync(dir)) {
        if (/^call-[a-f0-9-]{36}$/.test(file)) accept(file)
      }
    } catch (error) { onError(error) }
  }, 75)
  timer.unref()
  return { close() { clearInterval(timer) } }
}
