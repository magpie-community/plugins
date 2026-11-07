import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("packed V2 runtime: attribution, credential boundary, refresh, tools and disposal", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./runtime-fixture.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 20_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
