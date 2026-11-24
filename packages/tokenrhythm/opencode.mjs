// The package's OpenCode 1.x plugin, as OpenCode 1.x and magpie's host load
// it: its plugin function and nothing else (1.x refuses a package whose exports
// include anything but plugins). OpenCode 2.x loads opencode2.mjs, which runs
// this.
export { TokenRhythmAuthPlugin } from "./index.mjs"
