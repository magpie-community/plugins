import { pathsFor, startBridge } from "./bridge.mjs"

const instance = Symbol.for("magpie.yuri.bridge.v1")

export default async function Yuri() {
  if (!globalThis[instance]) {
    const paths = pathsFor()
    globalThis[instance] = { stop: startBridge(paths) }
  }
  return {}
}
