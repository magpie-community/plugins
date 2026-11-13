import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Never let the unit tests drive the real Trae window.
process.env.MAGPIE_TRAE_NO_API = "1"

import {
  applyMirror,
  cleanMcp,
  pathsFor,
  previewModels,
  syncAll,
  syncMcp,
} from "../bridge.mjs"

const temps = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture({ platform = "win32", appdata = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "magpie-trae-test-"))
  const home = join(root, "home")
  const env = appdata ? { APPDATA: join(home, "AppData", "Roaming") } : {}
  const p = pathsFor({ home, env, platform })
  for (const dir of [
    p.magpieDir,
    join(p.userData, "User"),
    p.skills,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  temps.push(root)
  return { root, home, p }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

test("pathsFor follows the three platforms", () => {
  const win = pathsFor({
    home: "C:\\Users\\ada",
    env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    platform: "win32",
  })
  assert.equal(win.targetMcp, join("C:\\Users\\ada\\AppData\\Roaming", "Trae", "User", "mcp.json"))
  assert.equal(win.connection, join("C:\\Users\\ada", ".trae", "magpie", "connection.json"))
  assert.equal(win.skills, join("C:\\Users\\ada", ".trae", "skills"))

  const mac = pathsFor({
    home: "/Users/ada",
    env: {},
    platform: "darwin",
  })
  assert.equal(mac.targetMcp, "/Users/ada/Library/Application Support/Trae/User/mcp.json")

  const linux = pathsFor({
    home: "/home/ada",
    env: {},
    platform: "linux",
  })
  assert.equal(linux.targetMcp, "/home/ada/.config/Trae/User/mcp.json")
})

test("syncMcp adds, updates and removes only what it owns", () => {
  const { p } = fixture()
  writeJson(p.targetMcp, {
    mcpServers: {
      mine: { command: "mine", args: [] },
      github: { command: "user-github" },
    },
  })
  writeJson(p.stagingMcp, {
    mcpServers: {
      github: { command: "magpie-github" },
      fetch: { command: "npx", args: ["-y", "mcp-fetch"] },
    },
  })

  const first = syncMcp(p)
  assert.equal(first.ok, true)
  assert.deepEqual(first.added, ["fetch"])
  assert.deepEqual(first.updated, [])
  assert.deepEqual(first.removed, [])
  assert.equal(first.skipped[0].name, "github")

  let target = readJson(p.targetMcp)
  assert.deepEqual(target.mcpServers.mine, { command: "mine", args: [] })
  assert.deepEqual(target.mcpServers.github, { command: "user-github" })
  assert.deepEqual(target.mcpServers.fetch, { command: "npx", args: ["-y", "mcp-fetch"] })

  // Magpie changes the server: it is updated because it still matches.
  writeJson(p.stagingMcp, {
    mcpServers: {
      fetch: { command: "npx", args: ["-y", "mcp-fetch@2"] },
    },
  })
  const second = syncMcp(p)
  assert.deepEqual(second.updated, ["fetch"])
  target = readJson(p.targetMcp)
  assert.deepEqual(target.mcpServers.fetch.args, ["-y", "mcp-fetch@2"])

  // Magpie removes it: it goes away.
  writeJson(p.stagingMcp, { mcpServers: {} })
  const third = syncMcp(p)
  assert.deepEqual(third.removed, ["fetch"])
  target = readJson(p.targetMcp)
  assert.equal(target.mcpServers.fetch, undefined)
  assert.deepEqual(target.mcpServers.mine, { command: "mine", args: [] })
})

test("a user edit stops the bridge managing that server", () => {
  const { p } = fixture()
  writeJson(p.stagingMcp, { mcpServers: { fetch: { command: "magpie" } } })
  syncMcp(p)

  // The user edits it in Trae.
  writeJson(p.targetMcp, {
    mcpServers: { fetch: { command: "user-edited" } },
  })
  const afterEdit = syncMcp(p)
  assert.equal(afterEdit.skipped[0].name, "fetch")
  assert.equal(readJson(p.targetMcp).mcpServers.fetch.command, "user-edited")
  assert.equal(existsSync(p.state), true)

  // Magpie now removes it from the staging file: the edit stays.
  writeJson(p.stagingMcp, { mcpServers: {} })
  const afterRemove = syncMcp(p)
  assert.equal(afterRemove.removed.length, 0)
  assert.equal(readJson(p.targetMcp).mcpServers.fetch.command, "user-edited")
})

test("cleanMcp removes only unchanged owned servers", () => {
  const { p } = fixture()
  writeJson(p.targetMcp, {
    mcpServers: {
      mine: { command: "mine" },
    },
  })
  writeJson(p.stagingMcp, {
    mcpServers: {
      fetch: { command: "magpie-fetch" },
      edited: { command: "magpie-edited" },
    },
  })
  syncMcp(p)
  // Edit one of the two after the bridge wrote it.
  const target = readJson(p.targetMcp)
  target.mcpServers.edited = { command: "user-edited" }
  writeJson(p.targetMcp, target)

  const clean = cleanMcp(p)
  assert.deepEqual(clean.removed, ["fetch"])
  assert.equal(clean.skipped[0].name, "edited")
  const after = readJson(p.targetMcp)
  assert.equal(after.mcpServers.fetch, undefined)
  assert.equal(after.mcpServers.edited.command, "user-edited")
  assert.equal(after.mcpServers.mine.command, "mine")
  assert.equal(existsSync(p.state), false)
})

test("a broken target is left alone, never overwritten", () => {
  const { p } = fixture()
  writeJson(p.stagingMcp, { mcpServers: { fetch: { command: "x" } } })
  writeFileSync(p.targetMcp, "{ not json", "utf8")
  assert.throws(() => syncMcp(p), /not valid JSON/)
  assert.equal(readFileSync(p.targetMcp, "utf8"), "{ not json")
})

test("syncAll reports one failure without stopping the other job", async () => {
  const { p } = fixture()
  writeFileSync(p.targetMcp, "{ broken", "utf8")
  writeJson(p.connection, {
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    apiKey: "gw-key",
    model: "group/example",
  })
  const out = await syncAll(p)
  assert.equal(out.mcp.ok, false)
  // The model mirror is a manual page action, never part of the bridge loop.
  assert.equal(out.models.reason, "manual")
})

test("a disconnected row takes its mirrored MCP servers back out", async () => {
  const { p } = fixture()
  writeJson(p.connection, {
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    apiKey: "gw-key",
    model: "group/example",
  })
  writeJson(p.stagingMcp, { mcpServers: { fetch: { command: "fetch" } } })
  const on = await syncAll(p)
  assert.equal(on.connected, true)
  assert.deepEqual(on.mcp.added, ["fetch"])
  assert.equal(readJson(p.targetMcp).mcpServers.fetch.command, "fetch")

  // Magpie empties the row's file when it is switched off or the plugin is
  // disabled; the bridge must not leave the mirrored server behind.
  writeJson(p.connection, {})
  const off = await syncAll(p)
  assert.equal(off.connected, false)
  assert.deepEqual(off.mcp.removed, ["fetch"])
  assert.equal(readJson(p.targetMcp).mcpServers.fetch, undefined)
})

test("applyMirror refuses to write without an explicit confirmation", async () => {
  const { p } = fixture()
  writeJson(p.connection, {
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    apiKey: "agent-key",
  })
  const out = await applyMirror(p, { previewId: "preview-1", confirm: false })
  assert.equal(out.code, "confirm-required")
})

test("previewModels reports a disconnected row", async () => {
  const { p } = fixture()
  const out = await previewModels(p)
  assert.equal(out.reason, "disconnected")
})

test("MCP state is keyed by name and only Magpie's servers are recorded", () => {
  const { p } = fixture()
  writeJson(p.targetMcp, { mcpServers: { mine: { command: "mine" } } })
  writeJson(p.stagingMcp, { mcpServers: { fetch: { command: "fetch" } } })
  syncMcp(p)
  const state = readJson(p.state)
  assert.deepEqual(Object.keys(state.owned), ["fetch"])
  assert.equal(state.version, 1)
})
