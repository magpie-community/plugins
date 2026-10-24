// Keep the provider's filesystem, environment and I/O mocks out of other packages.
import { test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL(".", import.meta.url))
test("private TRAE isolated protocol, account and lifecycle suite", () => {
  const home = mkdtempSync(join(tmpdir(), "trae-suite-home-"))
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home }
    for (const key of Object.keys(env)) if (key.startsWith("TRAE_PRIVATE_") || key === "TRAE_HOME") delete env[key]
    const result = spawnSync(process.execPath, ["test", "--preload", "./test/preload.mjs", "./index.cases.mjs", "./review.cases.mjs", "./lifecycle.cases.mjs"], {
      cwd: directory, env, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    })
    const output = `${result.stdout || ""}${result.stderr || ""}`
    if (result.status !== 0 || result.error) console.error(output, result.error || "")
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(output).toMatch(/^\s*112 pass\s*$/m)
    expect(output).toMatch(/^\s*0 fail\s*$/m)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 65000)
