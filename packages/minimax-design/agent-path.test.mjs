import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { mediaPaths, prepareAgentPath } from "./media-sync.mjs"

for (const platform of ["darwin", "win32"]) {
  test(`${platform} shared entry edits native files and preserves existing configuration`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "design-agent-path-"))
    try {
      const paths = mediaPaths(home, platform, path.join(home, "Roaming"))
      const entry = path.join(home, ".minimax-design")
      assert.equal(prepareAgentPath(paths, home), false)
      assert.equal(fs.existsSync(entry), false)
      fs.mkdirSync(path.dirname(paths.control), { recursive: true })
      fs.writeFileSync(paths.control, '{"theme":"original"}')
      assert.equal(prepareAgentPath(paths, home), true)
      assert.equal(prepareAgentPath(paths, home), true)
      assert.equal(fs.readFileSync(path.join(entry, "hub-config.json"), "utf8"), '{"theme":"original"}')
      const replacement = path.join(entry, "hub-config.json.tmp")
      fs.writeFileSync(replacement, '{"theme":"updated"}')
      fs.renameSync(replacement, path.join(entry, "hub-config.json"))
      assert.equal(fs.readFileSync(paths.control, "utf8"), '{"theme":"updated"}')
      const mcp = path.join(entry, "ai-runtime/config-home/opencode/opencode.json")
      fs.mkdirSync(path.dirname(mcp), { recursive: true })
      fs.writeFileSync(mcp, '{"mcp":{}}')
      assert.equal(fs.readFileSync(path.join(path.dirname(paths.control),
        "ai-runtime/config-home/opencode/opencode.json"), "utf8"), '{"mcp":{}}')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
}

test("an occupied shared entry is never replaced", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "design-agent-collision-"))
  try {
    const paths = mediaPaths(home, "darwin")
    fs.mkdirSync(path.dirname(paths.control), { recursive: true })
    const entry = path.join(home, ".minimax-design")
    fs.mkdirSync(entry)
    fs.writeFileSync(path.join(entry, "keep"), "original")
    assert.throws(() => prepareAgentPath(paths, home), /occupied/)
    assert.equal(fs.readFileSync(path.join(entry, "keep"), "utf8"), "original")
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
