// The OpenCode 1.x (and magpie) face of the package: the plugin functions and
// nothing else. OpenCode 1.x refuses a main whose exports include anything
// that isn't a plugin, so helpers stay in index.mjs / src.
export { TabbitPlugin } from "./index.mjs"
