import { pathsFor, startBridge, syncBridge } from "./bridge.mjs"

const instance = Symbol.for("magpie.yuri.bridge.v1")

export default async function Yuri() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    globalThis[instance] = { stop: startBridge(paths) }
    // Magpie unwires an agent before its host exits on disable/removal.
    process.once("exit", () => {
      try { syncBridge(paths) } catch {
        console.error("Yuri bridge restoration paused; recovery files retained.")
      }
    })
  }
  return {}
}
