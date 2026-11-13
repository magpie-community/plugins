import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pathsFor } from "../bridge.mjs"
import { startPageServer } from "../trae-page.mjs"

const temps = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("the page serves the preview UI and refuses an unconfirmed mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-trae-page-"))
  temps.push(root)
  const p = pathsFor({ home: root, env: {}, platform: "linux" })
  const server = startPageServer({ port: 0, paths: p, log: { log() {}, error() {} } })
  const port = await server.ready
  assert.ok(port > 0)
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes("Trae models"))
    assert.ok(html.includes("Mirror to Trae"))

    const preview = await fetch(`http://127.0.0.1:${port}/api/preview`).then((r) => r.json())
    assert.equal(preview.skipped, true)
    assert.equal(preview.reason, "disconnected")

    const refused = await fetch(`http://127.0.0.1:${port}/api/mirror`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previewId: "x", confirm: false }),
    })
    assert.equal(refused.status, 400)
    assert.equal((await refused.json()).code, "confirm-required")
  } finally {
    await server.close()
  }
})
