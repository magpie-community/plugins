import { test } from "bun:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

test("package.json names a loadable community agent plugin with its own sign-in", () => {
  assert.equal(pkg.name, "@magpie-community/agent-trae")
  assert.equal(pkg.repository?.directory, "packages/agent-trae")
  assert.equal(pkg.type, "module")
  assert.equal(pkg.main, "./index.mjs")
  assert.ok(existsSync(join(ROOT, pkg.main)))
  assert.equal(pkg.magpie.agent, "./trae.agent.js")
  assert.ok(existsSync(join(ROOT, pkg.magpie.agent)))
  assert.ok(existsSync(join(ROOT, "trae-api.mjs")))
  assert.ok(existsSync(join(ROOT, "trae-auth.mjs")))
  assert.ok(existsSync(join(ROOT, "trae-page.mjs")))
  for (const file of ["trae-api.mjs", "trae-auth.mjs", "trae-page.mjs", "page"]) {
    assert.ok(pkg.files.includes(file), `files should ship ${file}`)
  }
  // No companion extension: nothing extra is installed into Trae.
  assert.ok(!pkg.files.some((f) => f.startsWith("trae-extension")))
  assert.ok(!existsSync(join(ROOT, "trae-extension")))
  // No local credential decryption module.
  assert.ok(!existsSync(join(ROOT, "trae-crypto.mjs")))
  // The page is the visible confirmation step for model mirroring.
  assert.equal(pkg.magpie.page?.file, "page/index.html")
  assert.equal(pkg.magpie.page?.service?.port, 3499)
  assert.equal(pkg.magpie.panels, undefined)
  assert.ok(pkg.magpie.icon.startsWith("data:image/png;base64,"))
  assert.ok(pkg.keywords.includes("magpie-agent"))
})

test("the README documents the preview/confirm mirror and the plugin's own sign-in", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")
  for (const phrase of [
    "多模型",
    "先预览",
    "trae-agent",
    "per-agent",
    "不向 Trae 安装扩展",
    "MCP",
    "skills",
    "Trae CN",
    "bun test",
  ]) {
    assert.ok(readme.includes(phrase), `README should mention ${phrase}`)
  }
  // The old extension route must be gone from the docs too.
  assert.ok(!readme.includes("trae-extension"))
})
