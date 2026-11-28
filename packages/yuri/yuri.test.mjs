import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { parse } from "./vendor/main.js"
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
  assert.ok(pkg.files.includes("vendor"))
  assert.equal(pkg.dependencies, undefined)
  assert.deepEqual(Object.keys(pkg.magpie.summary).sort(), ["en", "zh"])
  assert.ok(Object.values(pkg.magpie.summary).every(text => typeof text === "string" && Buffer.byteLength(text) <= 300))
})

test("connect-only Agent keeps the gateway in its own sidecar", () => {
  assert.equal(agent.id, "yuri")
  assert.equal(agent.model, undefined)
  assert.equal(agent.notice, undefined)
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
    package: "@magpie-community/opencode-magpie-provider@0.1.0",
    options: { agentID: "yuri", remote: { baseURL: gateway.v1, tokenFile: p.control } },
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
  "@magpie-community/opencode-magpie-provider@0.1.0",
  { package: "@magpie-community/opencode-magpie-provider@0.2.0", options: { agentID: "mine" } },
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
  assert.equal(get(file).plugins[1].options.remote.tokenFile, p.control)
  assert.equal(fs.readFileSync(file, "utf8").includes("new-key"), false)
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

test("error notifications do not expose malformed config or credentials", async t => {
  const { p, file } = fixture(t)
  put(file, '{"secret":"never-log",')
  const errors = []
  const stop = startBridge(p, { interval: 5, onError: (...args) => errors.push(args) })
  put(p.control, connect({ gateway: { ...gateway, key: "updated-test-key" } }))
  await new Promise(resolve => setTimeout(resolve, 30))
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

test("a second process cannot write while another bridge writer holds the lock", t => {
  const { p, file } = fixture(t)
  const original = '{"model":"keep"}'
  put(file, original)
  put(p.state + ".lock", String(process.pid))
  const script = `import { syncBridge } from ${JSON.stringify(new URL("./bridge.mjs", import.meta.url).href)};
    try { syncBridge(${JSON.stringify(p)}); process.exitCode = 2 }
    catch (error) { if (!/Another Yuri bridge operation/.test(error.message)) throw error }`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(fs.existsSync(p.state), false)
  assert.equal(fs.readFileSync(p.state + ".lock", "utf8"), String(process.pid))
  fs.unlinkSync(p.state + ".lock")
  assert.equal(syncBridge(p), "connected")
})

test("reclaims a crashed writer's lock and releases its replacement", t => {
  const { p } = fixture(t)
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 })
  assert.equal(exited.status, 0)
  assert.throws(() => process.kill(exited.pid, 0), { code: "ESRCH" })
  put(p.state + ".lock", String(exited.pid))
  assert.equal(syncBridge(p), "connected")
  assert.equal(fs.existsSync(p.state + ".lock"), false)
})

test("rejects a user edit between read and commit before writing a recovery journal", t => {
  const { p, file } = fixture(t)
  put(file, '{}')
  const changed = '{"model":"user-edited-during-update"}'
  const read = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (target, ...args) {
    const text = read.call(this, target, ...args)
    if (target === file && ++reads === 1) put(file, changed)
    return text
  }
  try {
    assert.throws(() => syncBridge(p), /Configuration changed during update/)
  } finally { fs.readFileSync = read }
  assert.equal(fs.readFileSync(file, "utf8"), changed)
  assert.equal(fs.existsSync(p.state + ".pending"), false)
  assert.equal(fs.existsSync(p.state), false)
})

test("disconnect refuses duplicated managed entries and retains the ownership record", t => {
  const { p, file } = fixture(t)
  syncBridge(p)
  const state = fs.readFileSync(p.state, "utf8")
  const entry = JSON.parse(state).entry
  const duplicated = JSON.stringify({ plugins: [entry, entry], model: "keep" })
  put(file, duplicated)
  put(p.control, {})
  assert.throws(() => syncBridge(p), /Managed plugin duplicated/)
  assert.equal(fs.readFileSync(file, "utf8"), duplicated)
  assert.equal(fs.readFileSync(p.state, "utf8"), state)
  assert.equal(fs.existsSync(p.state + ".pending"), false)
})

for (const baseURL of ["file:///tmp/gateway", "ftp://example.test/v1", "https://user:pass@example.test/v1", "https://example.test/v1?token=hidden", "https://example.test/v1#fragment"]) {
  test("rejects non-HTTP or credential-bearing gateway URLs before touching OpenCode", t => {
    const { p, file } = fixture(t)
    put(p.control, { baseURL, gatewayKey: gateway.key })
    assert.throws(() => syncBridge(p), /Invalid Magpie API URL/)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(p.state), false)
  })
}

for (const gatewayKey of ["with space", "with\ttab", "with\r\nheader", "non-ascii-密钥", "delete-\x7f"]) {
  test("rejects whitespace, control and non-ASCII gateway keys before touching OpenCode", t => {
    const { p, file } = fixture(t)
    put(p.control, { baseURL: gateway.v1, gatewayKey })
    assert.throws(() => syncBridge(p), /Incomplete Yuri connection/)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(p.state), false)
  })
}

test("host exit restores a disconnected Agent even before the next poll", t => {
  const { home, p, file } = fixture(t)
  const original = '{ // keep\n "model":"mine"\n}'
  put(file, original)
  syncBridge(p)
  const script = `import fs from "node:fs";
    import Yuri from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)};
    await Yuri();
    if (!fs.existsSync(${JSON.stringify(p.state)})) throw new Error("Bridge did not connect");
    fs.writeFileSync(${JSON.stringify(p.control)}, "{}");
    process.exit(0)`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), OPENCODE_CONFIG_DIR: path.dirname(file), OPENCODE_CONFIG: "" },
    encoding: "utf8", timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(fs.existsSync(p.state), false)
})

test("recovery refuses a journal targeting a file outside the configured targets", t => {
  const { home, p } = fixture(t)
  const outside = path.join(home, "unrelated.json")
  put(outside, "original")
  const pending = { file: outside, before: "original", after: "overwritten", state: null }
  put(p.state + ".pending", pending)
  assert.throws(() => syncBridge(p), /Recovery target changed/)
  assert.equal(fs.readFileSync(outside, "utf8"), "original")
  assert.deepEqual(get(p.state + ".pending"), pending)
  assert.equal(fs.existsSync(p.state), false)
})

test("loading an already-connected host does not edit OpenCode until a connection transition", async t => {
  const { p, file } = fixture(t)
  const original = '{"model":"user/keep"}'
  put(file, original)
  const stop = startBridge(p, { interval: 5 })
  t.after(stop)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(fs.existsSync(p.state), false)
  put(p.control, {})
  await new Promise(resolve => setTimeout(resolve, 30))
  put(p.control, connect({ gateway }))
  for (let i = 0; i < 100 && !fs.existsSync(p.state); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(get(file).plugins[0].options.remote.tokenFile, p.control)
  for (const target of [file, p.state]) assert.equal(fs.readFileSync(target, "utf8").includes(gateway.key), false)
})

test("plugin load and exit leave an already-connected user's configuration untouched", t => {
  const { home, p, file } = fixture(t)
  const original = '{"model":"user/keep"}'
  put(file, original)
  const script = `import Yuri from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}; await Yuri(); process.exit(0)`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), OPENCODE_CONFIG_DIR: path.dirname(file), OPENCODE_CONFIG: "" },
    encoding: "utf8", timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(fs.existsSync(p.state), false)
})
