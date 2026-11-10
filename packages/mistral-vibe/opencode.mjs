// The package's OpenCode 1.x plugins, as OpenCode 1.x and magpie's host load
// them: its plugin function and nothing else (1.x refuses a package whose
// main exports include anything but plugins). OpenCode 2.x loads
// opencode2.mjs, which runs this.
export { MistralVibeAuthPlugin } from "./index.mjs"
