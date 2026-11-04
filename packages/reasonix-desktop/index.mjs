import { pathsFor, startBridge, syncBridge } from "./bridge.mjs"

const instance = Symbol.for("magpie.reasonix-desktop.bridge.v1")

// The Agent entry runs in moejs; this companion runs in the shared Bun host
// because current Magpie cannot edit TOML and a separate dotenv file there.
export default async function ReasonixDesktop() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    const stop = startBridge(paths)
    globalThis[instance] = { stop }
    // Magpie restores the control JSON before closing the host on disable or
    // removal. Flush it synchronously on normal exit, without taking over the
    // shared host's signals or terminating other plugins.
    process.once("exit", () => {
      try { syncBridge(paths) } catch {
        console.error("Reasonix bridge restoration paused; configuration and recovery files retained.")
      }
    })
  }
  return {}
}
