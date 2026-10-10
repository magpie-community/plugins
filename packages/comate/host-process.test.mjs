import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

test("neighbouring hosts are ignored unless the caller explicitly opts in", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "comate-host-opt-in-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const helper = join(root, "plugins/packages/comate/host-process.mjs")
  const adjacent = join(root, "magpie/internal/plugin/host.js")
  const nested = join(root, "plugins/internal/plugin/host.js")
  for (const path of [helper, adjacent, nested]) mkdirSync(dirname(path), { recursive: true })
  copyFileSync(new URL("./host-process.mjs", import.meta.url), helper)
  for (const path of [adjacent, nested]) writeFileSync(path, 'throw new Error("must not execute")')
  const { findMagpieHost } = await import(pathToFileURL(helper).href)
  assert.equal(findMagpieHost({}), "")
  assert.equal(findMagpieHost({ MAGPIE_BUN: process.execPath }), "")
  assert.equal(findMagpieHost({ MAGPIE_HOST: join(root, "missing.js") }), "")
  assert.equal(findMagpieHost({ MAGPIE_HOST: adjacent }), adjacent)
  assert.equal(findMagpieHost({ MAGPIE_CHECKOUT: join(root, "magpie") }), adjacent)
  assert.equal(findMagpieHost({ MAGPIE_HOST: nested, MAGPIE_CHECKOUT: join(root, "magpie") }), nested)
})
