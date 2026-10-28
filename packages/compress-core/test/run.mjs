// test/run.mjs — run every strategy's behavior tests.
// Each test module exports { name, run } ; run() uses helpers.check().
// Usage: node test/run.mjs [onlyThisTestName]

import { failedCount } from "./helpers.mjs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as joinPath } from "node:path"

// Every suite runs against a throwaway folder, so nothing a suite writes can
// land in the operator's own config folder.
const sandbox = mkdtempSync(joinPath(tmpdir(), "compress-core-suites-"))
process.env.MAGPIE_CONFIG_DIR = joinPath(sandbox, "config")

const suites = ["approved-lite.test.mjs", "gateway-cases.test.mjs", "engine-cases.test.mjs", "prefix-stability.test.mjs", "body-limit.test.mjs", "lite.test.mjs", "session-dedup.test.mjs", "headroom.test.mjs", "redact.test.mjs", "capture-store.test.mjs", "observability.test.mjs", "audit.test.mjs", "page-catalog.test.mjs"] // engines + the gateway contract + the two stability contracts + what the hook writes + the generated page catalog

const only = process.argv[2]
let any = false
for (const s of suites) {
  const mod = await import(`./${s}`)
  if (only && mod.name !== only) continue
  any = true
  console.log(`\n[${mod.name}]`)
  await mod.run()
}
if (!any) {
  console.error(only ? `no test suite named ${only}` : "no test suites")
  process.exit(2)
}
const n = failedCount()
console.log(n === 0 ? "\nall tests passed" : `\n${n} FAILURE(S)`)
process.exit(n === 0 ? 0 : 1)