// The package's OpenCode 1.x entry: its plugin function and nothing else.
// OpenCode 1.x refuses a package whose exports include anything but plugins,
// so index.mjs (which also exports _internal for the tests and the default
// { id, server } shape magpie reads) is not the 1.x entry.
export { DeepRelayPlugin } from "./index.mjs"
