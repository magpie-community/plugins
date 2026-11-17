import { pathsFor, startBridge, sync } from "./bridge.mjs"

const instance = Symbol.for("magpie.openbitfun.bridge.v1")

// The agent file runs in moejs, which edits a config a key path at a time and
// cannot add to OpenBitFun's ai.models array. This part runs in magpie's plugin
// host: it reads the file magpie wrote for this agent and keeps OpenBitFun's
// app.json in step with it, and takes the entries out when the agent is off.
export default async function OpenBitFunBridgePlugin() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    globalThis[instance] = { stop: startBridge(paths) }
    // magpie takes its lines out of the bridge file before it closes the host
    // on disable or removal: undo app.json on the way out, without waiting for
    // the next poll. With no bridge to read, sync reaches no await and the
    // file is written before this returns.
    process.once("exit", () => {
      sync(paths).catch((error) => console.error(`openbitfun bridge paused: ${error.message}`))
    })
  }
  return {}
}
