import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-provider-mutation-"))
try {
  for (const name of ["src", "tests", "package.json", "build.mjs"]) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true })
  }
  const build = () => {
    const result = spawnSync("bun", ["build.mjs"], { cwd: directory, encoding: "utf8", timeout: 20_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const run = () => spawnSync(process.execPath, ["tests/runtime-fixture.mjs"], { cwd: directory, encoding: "utf8", timeout: 20_000 })
  build()
  const baseline = run()
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  const file = path.join(directory, "src/catalog-cache.ts")
  const source = fs.readFileSync(file, "utf8")
  const mutant = source.replace('fetch(url, { redirect:', 'fetch(url, { headers: { Authorization: "Bearer test-only-gateway-key" }, redirect:')
  assert.notEqual(mutant, source, "models.dev request moved")
  fs.writeFileSync(file, mutant)
  build()
  const result = run()
  assert.equal(result.signal, null, "credential-leak test must fail, not time out")
  assert.notEqual(result.status, 0, "models.dev credential-leak mutation survived")
  assert.match(result.stderr, /AssertionError/)
  console.log("KILLED: models.dev gateway credential leak (baseline passes; mutated bundle fails)")
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
