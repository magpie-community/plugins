import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { parse } from "./vendor.mjs"
import { agent, connect } from "./yuri.agent.js"
import { pathsFor, syncBridge, startBridge } from "./bridge.mjs"

const gateway = { v1: "http://127.0.0.1:3425/v1", key: "test-only-yuri-key" }
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
}
const fixture = (t, env = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-yuri-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const p = pathsFor(home, env)
  put(p.control, connect({ gateway }))
  return { home, p, file: p.configs[1] }
}
const get = file => parse(fs.readFileSync(file, "utf8"))

test("Agent and plugin card embed the same original Yuri PNG for offline use", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  assert.equal(pkg.magpie.icon, agent.icon)
  assert.ok(agent.icon.startsWith("data:image/png;base64,"))
  const image = Buffer.from(agent.icon.split(",")[1], "base64")
  assert.equal(image.length, 1799)
  assert.equal(image.readUInt32BE(16), 32)
  assert.equal(image.readUInt32BE(20), 32)
  assert.equal(createHash("sha256").update(image).digest("hex"), "aacc7c4365bb7f90723634aa70351c150160ee028818e35314fbf9b04baa9dac")
  assert.ok(pkg.files.includes("ASSET_NOTICE.md"))
  assert.ok(pkg.files.includes("LICENSE-YURI"))
  assert.ok(pkg.files.includes("LICENSE-JSONC-PARSER"))
  assert.ok(pkg.files.includes("vendor.mjs"))
  assert.equal(pkg.dependencies, undefined)
})

test("connect-only Agent keeps the gateway in its own sidecar", () => {
  assert.equal(agent.id, "yuri")
  assert.equal(agent.model, undefined)
  assert.equal(agent.config, "~/.config/magpie/agents/yuri/connection.json")
  assert.deepEqual(connect({ gateway }), { baseURL: gateway.v1, gatewayKey: gateway.key })
  assert.throws(() => connect({ gateway: {} }))
})

test("merges one plugin, leaves comments/options/providers intact, restores byte for byte", t => {
  const { p, file } = fixture(t)
  const original = '\uFEFF{\r\n  // keep my plugins\r\n  "plugins": [\r\n    {"package":"other", "options":{"a":1}}, // keep this too\r\n  ],\r\n  "providers": {"own":{"name":"Mine"}},\r\n}\r\n'
  put(file, original)
  fs.chmodSync(file, 0o640)
  assert.equal(syncBridge(p), "connected")
  const installed = fs.readFileSync(file, "utf8")
  assert.ok(installed.includes("// keep my plugins"))
  assert.ok(installed.includes("// keep this too"))
  assert.ok(installed.includes('{"package":"other", "options":{"a":1}}'))
  assert.ok(installed.includes('"providers": {"own":{"name":"Mine"}}'))
  assert.deepEqual(get(file).plugins[1], {
    package: "opencode-magpie-plugin@0.5.1",
    options: { remote: { baseURL: gateway.v1, token: gateway.key } },
  })
  assert.equal(fs.statSync(file).mode & 0o777, 0o640)
  assert.equal(fs.statSync(p.state).mode & 0o777, 0o600)
  assert.equal(syncBridge(p), "connected")
  assert.equal(fs.readFileSync(file, "utf8"), installed)
  put(p.control, {})
  assert.equal(syncBridge(p), "disconnected")
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(fs.existsSync(p.state), false)
})

for (const entry of [
  "opencode-magpie-plugin@0.5.1",
  "opencode-magpie-plugin",
  { package: "opencode-magpie-plugin@0.4.2", options: { groups: [{ id: "mine" }], remote: { baseURL: "https://example.test/api", token: "existing" } } },
]) test(`preserves an existing ${typeof entry} plugin and never takes ownership`, t => {
  const { p, file } = fixture(t)
  const original = JSON.stringify({ plugins: [entry, "other"] })
  put(file, original)
  assert.equal(syncBridge(p), "existing")
  assert.equal(fs.existsSync(p.state), false)
  put(p.control, {})
  assert.equal(syncBridge(p), "disconnected")
  assert.equal(fs.readFileSync(file, "utf8"), original)
})

test("recognizes a local plugin package without executing it", t => {
  const { p, file, home } = fixture(t)
  const local = path.join(home, "my-plugin")
  put(path.join(local, "package.json"), { name: "opencode-magpie-plugin" })
  put(file, { plugins: [{ package: local, options: { order: {} } }] })
  assert.equal(syncBridge(p), "existing")
  assert.equal(get(file).plugins.length, 1)
})

test("checks both global layers for an existing pinned plugin", t => {
  const { p, file } = fixture(t)
  put(p.configs[0], { plugins: ["opencode-magpie-plugin@0.5.0"] })
  put(file, '{// unrelated higher layer\n"model":"mine"}')
  assert.equal(syncBridge(p), "existing")
  assert.equal(get(file).plugins, undefined)
})

test("disconnect removes only our item after unrelated edits, including newly added plugins", t => {
  const { p, file } = fixture(t)
  put(file, '{"plugins":["first"],"model":"old"}')
  syncBridge(p)
  const cfg = get(file)
  cfg.plugins.push({ package: "later", options: { keep: true } })
  cfg.model = "new"
  put(file, '// new user comment\n' + JSON.stringify(cfg))
  put(p.control, {})
  syncBridge(p)
  assert.deepEqual(get(file), { plugins: ["first", { package: "later", options: { keep: true } }], model: "new" })
  assert.ok(fs.readFileSync(file, "utf8").includes("// new user comment"))
})

test("an upgraded or removed owned entry stays user-managed", t => {
  const { p, file } = fixture(t)
  syncBridge(p)
  put(file, { plugins: [{ package: "opencode-magpie-plugin@9.0.0", options: { keep: true } }] })
  assert.equal(syncBridge(p), "user-managed")
  put(p.control, {})
  syncBridge(p)
  assert.equal(get(file).plugins[0].package, "opencode-magpie-plugin@9.0.0")
})

test("gateway changes update only the owned entry and still restore the original", t => {
  const { p, file } = fixture(t)
  const original = '{"plugins":["other"]}'
  put(file, original)
  syncBridge(p)
  put(p.control, connect({ gateway: { v1: "http://127.0.0.1:3435/v1", key: "new-key" } }))
  syncBridge(p)
  assert.equal(get(file).plugins[1].options.remote.token, "new-key")
  assert.deepEqual(get(file).plugins[0], "other")
  put(p.control, {})
  syncBridge(p)
  assert.equal(fs.readFileSync(file, "utf8"), original)
})

test("a new config is removed on disconnect, a comments-only config is restored", t => {
  for (const original of [null, "// my future config\n"]) {
    const { p, file } = fixture(t)
    if (original !== null) put(file, original)
    syncBridge(p)
    assert.equal(get(file).plugins.length, 1)
    put(p.control, {})
    syncBridge(p)
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null, original)
  }
})

for (const source of ['{"plugins": [', '{"plugins":{},"secret":"never-log"}', '{"plugins":[],"plugins":[]}', "null", "42", "[]"]) {
  test("invalid/ambiguous configuration is not rewritten", t => {
    const { p, file } = fixture(t)
    put(file, source)
    assert.throws(() => syncBridge(p))
    assert.equal(fs.readFileSync(file, "utf8"), source)
    assert.equal(fs.existsSync(p.state), false)
  })
}

test("refuses symbolic config files without replacing the link or its target", t => {
  const { p, file, home } = fixture(t)
  const target = path.join(home, "dotfiles.jsonc")
  put(target, "{}")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.symlinkSync(target, file)
  assert.throws(() => syncBridge(p), /regular files/)
  assert.equal(fs.readFileSync(target, "utf8"), "{}")
  assert.ok(fs.lstatSync(file).isSymbolicLink())
})

test("replays an interrupted edit but refuses recovery over concurrent changes", t => {
  const { p, file } = fixture(t)
  put(file, "{}")
  syncBridge(p)
  const state = JSON.parse(fs.readFileSync(p.state, "utf8"))
  put(file, state.before)
  fs.unlinkSync(p.state)
  put(p.state + ".pending", { file, before: state.before, after: state.after, state })
  syncBridge(p)
  assert.equal(fs.readFileSync(file, "utf8"), state.after)
  put(p.state + ".pending", { file, before: state.before, after: state.after, state })
  put(file, '{"user":"changed"}')
  assert.throws(() => syncBridge(p), /recovery/)
  assert.equal(fs.readFileSync(file, "utf8"), '{"user":"changed"}')
  assert.ok(fs.existsSync(p.state + ".pending"))
})

test("respects OpenCode config directory overrides", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-yuri-paths-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const p = pathsFor(home, { OPENCODE_CONFIG_DIR: path.join(home, "custom"), XDG_CONFIG_HOME: path.join(home, "xdg"), OPENCODE_CONFIG: path.join(home, "explicit.jsonc") })
  assert.deepEqual(p.configs, [path.join(home, "custom", "opencode.json"), path.join(home, "custom", "opencode.jsonc"), path.join(home, "explicit.jsonc")])
  assert.equal(p.control, path.join(home, ".config", "magpie", "agents", "yuri", "connection.json"))
  put(p.control, connect({ gateway }))
  put(p.configs[1], '{"model":"keep"}')
  syncBridge(p)
  assert.equal(get(p.target).plugins.length, 1)
  assert.deepEqual(get(p.configs[1]), { model: "keep" })
})

test("error notifications do not expose malformed config or credentials", t => {
  const { p, file } = fixture(t)
  put(file, '{"secret":"never-log",')
  const errors = []
  const stop = startBridge(p, { onError: (...args) => errors.push(args) })
  stop()
  assert.deepEqual(errors, [[]])
})

test("bridge-owned files stay under Magpie, without creating Yuri's data directory", t => {
  const { home, p } = fixture(t)
  const ownDirectory = path.join(home, ".config", "magpie", "agents", "yuri")
  assert.equal(p.control, path.join(ownDirectory, "connection.json"))
  assert.equal(p.state, path.join(ownDirectory, "state.json"))
  assert.equal(p.control, agent.config.replace(/^~(?=\/|$)/, home))
  syncBridge(p)
  assert.ok(fs.existsSync(p.state))
  assert.equal(fs.existsSync(path.join(home, ".config", "yuri")), false)
  put(p.control, {})
  syncBridge(p)
  assert.equal(fs.existsSync(p.state), false)
  assert.equal(fs.existsSync(path.join(home, ".config", "yuri")), false)
})
