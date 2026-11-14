import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { nativeMcpServer, readMcpVault, syncMcpStore } from "./mcp-store.mjs"

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-mcp-store-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const control = path.join(root, "hub-config.json")
  fs.writeFileSync(control, JSON.stringify({ customMcpVault: "", unrelated: "keep" }))
  fs.writeFileSync(path.join(root, ".token-key"), Buffer.alloc(32, 3))
  const write = (mcp) => fs.writeFileSync(path.join(root, "library-mcp.json"), JSON.stringify({ mcp }))
  return { control, root, write }
}

test("native MCP is encrypted locally and changes wait until Design exits", (t) => {
  const fixture = sandbox(t)
  fixture.write({ alternate: { type: "remote", url: "http://127.0.0.1:2345/mcp" } })
  assert.equal(syncMcpStore(fixture, { isRunning: true }).pending, true)
  assert.equal(readMcpVault(fixture.control).servers.alternate, undefined)
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, true)
  assert.match(JSON.parse(fs.readFileSync(fixture.control)).customMcpVault, /^v2enc:/)
  assert.equal(readMcpVault(fixture.control).servers.alternate.config.transport, "http")
  assert.equal(JSON.parse(fs.readFileSync(fixture.control)).unrelated, "keep")
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, false)
  fixture.write({})
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(readMcpVault(fixture.control).servers, {})
})

test("native discovery budget covers a router list and preserves explicit timeouts", () => {
  const remote = { type: "remote", url: "https://example.invalid/mcp" }
  assert.equal(nativeMcpServer("router", remote).config.timeoutMs, 60000)
  assert.equal(nativeMcpServer("direct", { ...remote, timeout: 12000 }).config.timeoutMs, 12000)
})

test("ready migration still detects a reintroduced bridge and owned runtime entry", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "https://example.invalid/mcp" }
  fixture.write({ router: remote })
  syncMcpStore(fixture, { isRunning: false })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  const plugin = new URL("./runtime/mcp-runtime.mjs", import.meta.url).href
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { router: remote }, plugin: [plugin, "mine"] }))
  assert.equal(syncMcpStore(fixture, { isRunning: true }).pending, true)
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)), { mcp: {}, plugin: ["mine"] })
})

test("verified legacy ownership cleans withdrawn direct entries when staging becomes a router", (t) => {
  const fixture = sandbox(t)
  const legacyManaged = { docs: { type: "remote", url: "https://docs.invalid/mcp" } }
  fixture.write({ router: { type: "remote", url: "https://router.invalid/mcp" } })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  const mine = { type: "remote", url: "https://mine.invalid/mcp" }
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { ...legacyManaged, mine } }))
  assert.equal(syncMcpStore(fixture, { isRunning: true, legacyManaged }).pending, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, { ...legacyManaged, mine })
  syncMcpStore(fixture, { isRunning: false, legacyManaged })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, { mine })
  assert.deepEqual(Object.keys(readMcpVault(fixture.control).servers), ["router"])
})

test("verified legacy ownership cannot remove a locally edited direct server", (t) => {
  const fixture = sandbox(t)
  fixture.write({})
  const legacyManaged = { docs: { type: "remote", url: "https://docs.invalid/mcp" } }
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  const original = JSON.stringify({ mcp: { docs: { ...legacyManaged.docs, enabled: false } } })
  fs.writeFileSync(runtime, original)
  assert.throws(() => syncMcpStore(fixture, { isRunning: false, legacyManaged }), /runtime config conflicts/)
  assert.equal(fs.readFileSync(runtime, "utf8"), original)
  fs.writeFileSync(runtime, JSON.stringify({ mcp: legacyManaged }))
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
})

test("ownership remembers prior direct configs across a switch to a router", (t) => {
  const fixture = sandbox(t)
  const direct = { type: "remote", url: "https://docs.invalid/mcp" }
  fixture.write({ docs: direct })
  syncMcpStore(fixture, { isRunning: false })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: direct } }))
  fixture.write({ router: { type: "remote", url: "https://router.invalid/mcp" } })
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
  assert.deepEqual(Object.keys(readMcpVault(fixture.control).servers), ["router"])
})

test("withdrawal removes the exact runtime projection emitted by native Design", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "https://docs.invalid/mcp" }
  fixture.write({ docs: remote })
  syncMcpStore(fixture, { isRunning: false })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: { ...remote, enabled: true, timeout: 60000 } } }))
  fixture.write({})
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
  assert.deepEqual(readMcpVault(fixture.control).servers, {})
})

test("withdrawing a natively disabled managed server cleans its disabled runtime projection", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "https://docs.invalid/mcp" }
  fixture.write({ docs: remote })
  syncMcpStore(fixture, { isRunning: false })
  const vault = readMcpVault(fixture.control)
  vault.servers.docs.enabled = false
  fs.writeFileSync(fixture.control, JSON.stringify({ customMcpVault: JSON.stringify(vault) }))
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: { ...remote, enabled: false, timeout: 60000 } } }))
  fixture.write({})
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
})

test("same-name Library updates retain both runtime definitions until cleanup succeeds", (t) => {
  const fixture = sandbox(t)
  const old = { type: "remote", url: "https://old.invalid/mcp" }
  const current = { type: "remote", url: "https://new.invalid/mcp" }
  fixture.write({ docs: old })
  syncMcpStore(fixture, { isRunning: false })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: old } }))
  fixture.write({ docs: current })
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
  assert.equal(readMcpVault(fixture.control).servers.docs.config.url, current.url)
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: { ...current, enabled: false } } }))
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /runtime config conflicts/)
  assert.equal(JSON.parse(fs.readFileSync(runtime)).mcp.docs.enabled, false)
})

test("failed cleanup retains the old definition across retries after a same-name update", (t) => {
  const fixture = sandbox(t)
  const old = { type: "remote", url: "https://old.invalid/mcp" }
  const current = { type: "remote", url: "https://new.invalid/mcp" }
  fixture.write({ docs: old })
  syncMcpStore(fixture, { isRunning: false })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, "invalid-json")
  fixture.write({ docs: current })
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), SyntaxError)
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { docs: old } }))
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp, {})
  assert.equal(readMcpVault(fixture.control).servers.docs.config.url, current.url)
})

test("native MCP preserves unrelated services and refuses name conflicts", (t) => {
  const fixture = sandbox(t)
  const own = { name: "mine", enabled: false, config: { transport: "stdio", command: "/bin/mine" } }
  fs.writeFileSync(fixture.control, JSON.stringify({ customMcpVault: JSON.stringify({
    version: 1, servers: { mine: own }, records: { mine: { source: "custom" } },
  }) }))
  fixture.write({ other: { type: "local", command: ["/other/node", "run.mjs"], environment: { EXAMPLE: "value" } } })
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(readMcpVault(fixture.control).servers.mine, own)
  assert.equal(readMcpVault(fixture.control).servers.other.config.env.EXAMPLE, "value")
  fixture.write({ mine: { type: "remote", url: "http://example.invalid/mcp" } })
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /outside Magpie/)
})

test("unreadable vault fails without changing configuration", (t) => {
  const fixture = sandbox(t)
  fixture.write({ remote: { type: "remote", url: "https://example.invalid/mcp" } })
  fs.writeFileSync(fixture.control, '{"customMcpVault":"v2enc:broken"}')
  const original = fs.readFileSync(fixture.control, "utf8")
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /encoding/)
  assert.equal(fs.readFileSync(fixture.control, "utf8"), original)
})

test("native switches persist, Library changes win, and local config edits block withdrawal", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "http://127.0.0.1:2345/mcp" }
  fixture.write({ remote })
  syncMcpStore(fixture, { isRunning: false })
  const vault = readMcpVault(fixture.control)
  vault.servers.remote.enabled = false
  fs.writeFileSync(fixture.control, JSON.stringify({ customMcpVault: JSON.stringify(vault) }))
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, false)
  assert.equal(readMcpVault(fixture.control).servers.remote.enabled, false)
  fixture.write({ remote: { ...remote, enabled: false } })
  syncMcpStore(fixture, { isRunning: false })
  fixture.write({ remote: { ...remote, enabled: true } })
  syncMcpStore(fixture, { isRunning: false })
  assert.equal(readMcpVault(fixture.control).servers.remote.enabled, true)
  const edited = readMcpVault(fixture.control)
  edited.servers.remote.config.url = "https://user.invalid/mcp"
  fs.writeFileSync(fixture.control, JSON.stringify({ customMcpVault: JSON.stringify(edited) }))
  fixture.write({})
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /local edits/)
  assert.equal(readMcpVault(fixture.control).servers.remote.config.url, "https://user.invalid/mcp")
})

test("migration removes only identical Library runtime entries after local save", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "http://127.0.0.1:2345/mcp" }
  fixture.write({ remote })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  const original = { mcp: { remote, mine: { type: "remote", url: "https://mine.invalid/mcp" } }, plugin: ["user-plugin"] }
  fs.writeFileSync(runtime, JSON.stringify(original))
  syncMcpStore(fixture, { isRunning: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)), original)
  syncMcpStore(fixture, { isRunning: false })
  const migrated = JSON.parse(fs.readFileSync(runtime))
  assert.equal(migrated.mcp.remote, undefined)
  assert.deepEqual(migrated.mcp.mine, original.mcp.mine)
  assert.deepEqual(migrated.plugin, ["user-plugin"])
  assert.deepEqual(JSON.parse(fs.readFileSync(`${runtime}.before-native-mcp.json`)), original)
})

test("invalid encryption key leaves the original bytes intact", (t) => {
  const fixture = sandbox(t)
  fixture.write({ remote: { type: "remote", url: "https://example.invalid/mcp" } })
  fs.writeFileSync(path.join(fixture.root, ".token-key"), "bad-key")
  const before = fs.readFileSync(fixture.control)
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /key is invalid/)
  assert.deepEqual(fs.readFileSync(fixture.control), before)
})

test("invalid staging and colliding runtime names never mutate the vault", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "https://example.invalid/mcp" }
  fixture.write({ valid: remote })
  syncMcpStore(fixture, { isRunning: false })
  const before = fs.readFileSync(fixture.control)
  for (const mcp of [
    { one: { ...remote, url: "file:///tmp/mcp" } },
    { "same.name": remote, SAME_NAME: remote },
    { design_private: remote },
    { one: { ...remote, timeout: -1 } },
    { one: { type: "local", command: ["node", 5] } },
  ]) {
    fixture.write(mcp)
    assert.throws(() => syncMcpStore(fixture, { isRunning: false }))
    assert.deepEqual(fs.readFileSync(fixture.control), before)
  }
  fs.writeFileSync(path.join(fixture.root, "library-mcp.json"), "{}")
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /mcp object/)
  assert.deepEqual(fs.readFileSync(fixture.control), before)
})

test("failed bridge cleanup is retried before native migration is marked ready", (t) => {
  const fixture = sandbox(t)
  const remote = { type: "remote", url: "https://example.invalid/mcp" }
  fixture.write({ remote })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  const ownership = path.join(fixture.root, ".magpie-mcp/ownership.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, "invalid-json")
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), SyntaxError)
  assert.ok(readMcpVault(fixture.control).servers.remote)
  assert.equal(JSON.parse(fs.readFileSync(ownership)).nativeReady, false)
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { remote } }))
  assert.equal(syncMcpStore(fixture, { isRunning: true }).pending, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).mcp.remote, remote)
  syncMcpStore(fixture, { isRunning: false })
  assert.equal(JSON.parse(fs.readFileSync(runtime)).mcp.remote, undefined)
  assert.equal(JSON.parse(fs.readFileSync(ownership)).nativeReady, true)
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, false)
})

test("different legacy runtime config blocks migration without replacing either service", (t) => {
  const fixture = sandbox(t)
  const old = { type: "remote", url: "https://old.invalid/mcp", enabled: true }
  const desired = { ...old, url: "https://new.invalid/mcp", enabled: false }
  fixture.write({ probe: desired })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  const ownership = path.join(fixture.root, ".magpie-mcp/ownership.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  const original = JSON.stringify({ mcp: { probe: old }, plugin: ["user-plugin"] })
  fs.writeFileSync(runtime, original)
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /runtime config conflicts.*probe/)
  assert.equal(fs.readFileSync(runtime, "utf8"), original)
  assert.equal(JSON.parse(fs.readFileSync(ownership)).nativeReady, false)
  assert.equal(readMcpVault(fixture.control).servers.probe.enabled, false)
  assert.throws(() => syncMcpStore(fixture, { isRunning: false }), /runtime config conflicts.*probe/)
  fs.writeFileSync(runtime, JSON.stringify({ mcp: { probe: desired }, plugin: ["user-plugin"] }))
  syncMcpStore(fixture, { isRunning: false })
  assert.equal(JSON.parse(fs.readFileSync(runtime)).mcp.probe, undefined)
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime)).plugin, ["user-plugin"])
  assert.equal(JSON.parse(fs.readFileSync(ownership)).nativeReady, true)
})

test("matching legacy runtime configs compare by fields regardless of key order", (t) => {
  const fixture = sandbox(t)
  fixture.write({ probe: { type: "remote", url: "https://example.invalid/mcp", enabled: false } })
  const runtime = path.join(fixture.root, "ai-runtime/config-home/opencode/opencode.json")
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(runtime, JSON.stringify({
    mcp: { probe: { enabled: false, url: "https://example.invalid/mcp", type: "remote" } },
  }))
  syncMcpStore(fixture, { isRunning: false })
  assert.equal(JSON.parse(fs.readFileSync(runtime)).mcp.probe, undefined)
})

test("native field normalization and key order do not prevent refresh or withdrawal", (t) => {
  const fixture = sandbox(t)
  fixture.write({
    local: { type: "local", command: [" /fixture/node ", "run.mjs"], environment: { " TEST ": "value" } },
    remote: { type: "remote", url: " https://example.invalid/mcp ", headers: { " X-Test ": "value" } },
  })
  syncMcpStore(fixture, { isRunning: false })
  const vault = readMcpVault(fixture.control)
  assert.equal(vault.servers.local.config.command, "/fixture/node")
  assert.deepEqual(vault.servers.local.config.env, { TEST: "value" })
  assert.equal(vault.servers.remote.config.url, "https://example.invalid/mcp")
  assert.deepEqual(vault.servers.remote.config.headers, { "X-Test": "value" })
  vault.servers.local.config = {
    env: { TEST: "value" }, args: ["run.mjs"], command: "/fixture/node", transport: "stdio", timeoutMs: 60000,
  }
  fs.writeFileSync(fixture.control, JSON.stringify({ customMcpVault: JSON.stringify(vault) }))
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, false)
  fixture.write({})
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(readMcpVault(fixture.control).servers, {})
})

test("pre-normalization ownership remains manageable after Design trims fields", (t) => {
  const fixture = sandbox(t)
  fixture.write({ local: { type: "local", command: [" /fixture/node "], environment: { " TEST ": "value" } } })
  const original = { name: "local", enabled: true, config: {
    transport: "stdio", command: " /fixture/node ", args: [], env: { " TEST ": "value" },
  } }
  const normalized = { ...original, config: { transport: "stdio", command: "/fixture/node", args: [], env: { TEST: "value" }, timeoutMs: 60000 } }
  const ownership = path.join(fixture.root, ".magpie-mcp/ownership.json")
  fs.mkdirSync(path.dirname(ownership))
  fs.writeFileSync(ownership, JSON.stringify({ servers: { local: original }, nativeReady: true }))
  fs.writeFileSync(fixture.control, JSON.stringify({
    customMcpVault: JSON.stringify({ version: 1, servers: { local: normalized }, records: { local: { source: "custom" } } }),
  }))
  assert.equal(syncMcpStore(fixture, { isRunning: false }).changed, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(ownership)).servers.local, normalized)
  fixture.write({})
  syncMcpStore(fixture, { isRunning: false })
  assert.deepEqual(readMcpVault(fixture.control).servers, {})
})
