import { test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { testRuntime } from "./test-runtime.mjs"

const { node, env } = testRuntime

// Keep Node's mock timers and per-file global fetch isolation under Bun CI.
test("SAP AI Core runtime regressions (isolated Node runner)", () => {
  const files = readdirSync(join(import.meta.dir, "node-tests")).filter(name => name.endsWith(".js")).sort().map(name => join(import.meta.dir, "node-tests", name))
  try {
    execFileSync(node, ["--test", ...files], { cwd: import.meta.dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000 })
  } catch (error) {
    throw new Error((error.stdout ?? "") + (error.stderr ?? "") + error.message)
  }
}, 120000)
