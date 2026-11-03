import { delimiter, dirname } from "node:path"

// Preloaded before any test module can narrow PATH or replace HOME.
const path = process.env.PATH ?? ""
const node = Bun.which("node", { PATH: path })
const git = Bun.which("git", { PATH: path })
if (!node || !git) throw new Error("SAP AI Core regressions require Node >=22 and Git; preload test-runtime.mjs before the suite mutates PATH.")
export const testRuntime = Object.freeze({
  node,
  env: Object.freeze({ ...process.env, PATH: [dirname(node), dirname(git), path].join(delimiter) }),
})
