// Bun 与 Node 都只运行这个包装测试，插件与假凭据留在独立子进程。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
test("TRAE 协议回归在隔离子进程中通过", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "trae-provider-test-"))
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("TRAE_PRIVATE_") || key === "NODE_OPTIONS") delete env[key]
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP", "TRAE_HOME", "APPDATA", "LOCALAPPDATA"]) {
      env[key] = join(sandbox, key)
      mkdirSync(env[key], { recursive: true })
    }
    env.TRAE_TEST_ROOT = sandbox
    const result = spawnSync(process.versions.bun ? "node" : process.execPath, [
      "--import", join(root, "test/isolate.mjs"), join(root, "test/cases.mjs"),
    ], { cwd: sandbox, env, encoding: "utf8", timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /\d+\/\d+ passed/)
    process.stdout.write(result.stdout)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
