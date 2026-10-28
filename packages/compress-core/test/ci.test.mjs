// test/ci.test.mjs — the suites, seen by `bun test`.
//
// Every suite exports { name, run } and asserts through helpers.check(), which
// counts failures instead of throwing — so `bun test` loaded them and found no
// tests at all. This file turns each suite into one bun:test test that fails
// when that suite's own counter moved. `node test/run.mjs` still runs them
// directly; neither entry point needs the other.
import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failedCount } from "./helpers.mjs"

// The same throwaway folders test/run.mjs uses: nothing may land in the
// installed plugin folder while the suites run.
const sandbox = mkdtempSync(join(tmpdir(), "compress-core-bun-"))
process.env.MAGPIE_CONFIG_DIR = join(sandbox, "config")

// Kept in the same order as test/run.mjs.
const suites = [
  "approved-lite.test.mjs",
  "gateway-cases.test.mjs",
  "engine-cases.test.mjs",
  "prefix-stability.test.mjs",
  "body-limit.test.mjs",
  "lite.test.mjs",
  "session-dedup.test.mjs",
  "headroom.test.mjs",
  "redact.test.mjs",
  "capture-store.test.mjs",
  "observability.test.mjs",
  "audit.test.mjs",
]

for (const file of suites) {
  const mod = await import(`./${file}`)
  test(mod.name || file, async () => {
    const before = failedCount()
    await mod.run()
    expect(failedCount() - before).toBe(0)
  }, 30000)
}