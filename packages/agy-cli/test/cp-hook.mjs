// Preloaded for test/platform.mjs, test/compat.mjs and test/usage.mjs under bun.
// Those tests replace childProcess.spawn and call syncBuiltinESMExports(), which
// Node uses to push the change into named imports. Bun has no such step, so
// node:child_process is mocked once here: its default export is a plain object
// the tests write to, and every named export calls through that object. Each
// file runs in its own bun process (see ../agy-cli.test.mjs), so the mock never
// reaches another package's tests.
import { mock } from "bun:test"
import * as real from "node:child_process"

const live = { ...real }
const named = {}
for (const [key, value] of Object.entries(real)) {
  if (key === "default") continue
  named[key] = typeof value === "function" ? (...args) => live[key](...args) : value
}
mock.module("node:child_process", () => ({ ...named, default: live }))
