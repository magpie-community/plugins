import { pathsFor, startBridge, sync } from "./bridge.mjs"

const instance = Symbol.for("magpie.cteno.bridge.v1")

// cteno.agent.js runs in moejs, which edits a single static JSON file by
// dotted object keys. This module runs in magpie's plugin host and mirrors
// connection.json into Cteno's OS-specific profiles.json array, restoring
// the user's file when disconnected or disabled.
export default async function CtenoBridgePlugin() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    globalThis[instance] = { stop: startBridge(paths) }
    // magpie clears connection.json before closing the host on disable or
    // removal: put profiles.json back on the way out without waiting for the
    // next poll.
    process.once("exit", () => {
      try {
        sync(paths)
      } catch (e) {
        console.error(`cteno bridge paused, profiles.json left as it is${e.refusal ? `: ${e.message}` : ""}`)
      }
    })
  }
  return {}
}
