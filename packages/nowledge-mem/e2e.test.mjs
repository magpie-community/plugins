// Runs the live checks in e2e.run.mjs when NMEM_E2E=1 and a Nowledge Mem is
// configured by the repository's .env (NMEM_API_URL and NMEM_API_KEY) or the
// environment. Without both nothing is spawned and no request leaves this
// machine, so the repository's tests stay offline by default.
//
// The runner is a separate process: the offline tests replace globalThis.fetch
// (packages/cursor/nonet.mjs) to keep Cursor's token local, and a live check
// must not share that process.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

function configured() {
  if (process.env.NMEM_API_URL && process.env.NMEM_API_KEY) return true
  const path = fileURLToPath(new URL("../../.env", import.meta.url))
  if (!existsSync(path)) return false
  const text = readFileSync(path, "utf8")
  return /^\s*(?:export\s+)?NMEM_API_URL\s*=\s*\S+/mu.test(text) && /^\s*(?:export\s+)?NMEM_API_KEY\s*=\s*\S+/mu.test(text)
}

const e2e = process.env.NMEM_E2E === "1" && configured() ? test : test.skip

e2e("the live Nowledge Mem checks pass", () => {
  const runner = fileURLToPath(new URL("./e2e.run.mjs", import.meta.url))
  const result = Bun.spawnSync({
    cmd: [process.execPath, runner],
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  })
  const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`
  if (result.exitCode !== 0) console.error(output)
  expect(result.exitCode).toBe(0)
}, 240_000)
