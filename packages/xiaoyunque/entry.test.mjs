import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import * as legacy from "./opencode.mjs"
import modern from "./opencode2.mjs"
import { XiaoyunquePlugin } from "./index.mjs"

test("package entries expose only the plugin to legacy hosts and setup to OpenCode 2", async () => {
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
  assert.equal(pkg.main, "./opencode.mjs")
  assert.equal(pkg.exports["./server"], "./index.mjs")
  assert.equal(pkg.exports["."], "./opencode2.mjs")
  assert.deepEqual(Object.keys(legacy), ["XiaoyunquePlugin"])
  assert.equal(legacy.XiaoyunquePlugin, XiaoyunquePlugin)
  assert.equal(modern.id, pkg.name)
  assert.equal(typeof modern.setup, "function")
  for (const entry of [pkg.main, ...Object.values(pkg.exports)]) {
    assert.ok(pkg.files.includes(entry.slice(2)), `${entry} must be packed`)
  }
})
