import { pathsFor, startBridge, sync } from "./bridge.mjs"

const instance = Symbol.for("magpie.zycode.bridge.v1")

// The agent file runs in moejs, which edits json, yaml and env but not
// TOML. This part runs in magpie's plugin host and puts what magpie wrote
// to local.env into the [model] table of agent.toml, and takes it out again.
export default async function ZycodeBridgePlugin() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    globalThis[instance] = { stop: startBridge(paths) }
    // magpie takes its lines out of local.env before it closes the host on
    // disable or removal: undo agent.toml on the way out, without waiting
    // for the next poll.
    process.once("exit", () => {
      try { sync(paths) } catch (e) { console.error(`zycode bridge paused, agent.toml left as it is${e.refusal ? `: ${e.message}` : ""}`) }
    })
  }
  return {}
}
