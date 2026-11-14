import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { createDecipheriv } from "node:crypto"
import { readMcpVault, syncMcpStore } from "./mcp-store.mjs"

const app = process.env.MINIMAX_APP
if (!app) throw new Error("Set MINIMAX_APP for native saved-MCP validation.")
const archive = fs.readFileSync(path.join(app, "Contents/Resources/app.asar"))
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)))
const base = 8 + archive.readUInt32LE(4)
const chunks = Object.values(header.files.out.files.main.files.chunks.files).map((entry) =>
  archive.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size).toString())
const main = chunks.find((source) => source.includes("var CustomMcpMainService="))
const validation = chunks.find((source) => source.includes("function normalizeCustomMcpServerInput("))
assert.ok(main && validation, "Installed Design saved-MCP implementation is unavailable.")
const normalization = validation.slice(validation.indexOf("var COMMAND_PATH="), validation.indexOf("var CUSTOM_MCP_ENV_MARKER="))
const parsing = main.slice(main.indexOf("var VAULT_VERSION="), main.indexOf("var SERVER_OAUTH_EXPIRY_SKEW_MS="))
const service = main.slice(main.indexOf("var CustomMcpMainService="), main.indexOf("CustomMcpMainService=__decorate"))
const decryption = main.slice(main.indexOf("function readKey(directory)"), main.indexOf("function encryptToken("))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-native-store-"))
const control = path.join(root, "hub-config.json")
const input = path.join(root, "library-mcp.json")
const errors = []
const native = vm.runInNewContext(`
  ${normalization}
  ${parsing}
  ${service}
  ${decryption}
  ({ CustomMcpMainService, decryptToken })
`, {
  fs, path, Buffer, URL, structuredClone, createDecipheriv, ENCRYPTED_V2_PREFIX: "v2enc:", ALGORITHM: "aes-256-gcm",
  createDecorator: () => ({}), isBuiltinMcpNamespace: (name) => name === "design",
  isBuiltinConnectorId: () => false,
  runtimeIdentity: (name) => name.replaceAll(".", "_").toLowerCase(),
  mcpNameIdentity: (name) => name.replaceAll(".", "_").toLowerCase(),
  customMcpRuntimeName: (name) => name,
  Disposable: class { _register(value) { return value } },
  Emitter: class { event() {} },
  CustomMcpRuntimeProjector: class {},
  isCommandFile: (file) => fs.existsSync(file),
})

try {
  fs.writeFileSync(control, JSON.stringify({ customMcpVault: "", unrelated: "keep" }))
  fs.writeFileSync(path.join(root, ".token-key"), Buffer.alloc(32, 7))
  fs.writeFileSync(input, JSON.stringify({ mcp: {
    "fixture-http": { type: "remote", url: " http://127.0.0.1:2345/mcp ", timeout: 15000, headers: { " X-Test ": "value" } },
    "fixture-local": { type: "local", command: [" /fixture/node ", "run.mjs"], enabled: false, environment: { " TEST ": "value" } },
  } }))
  syncMcpStore({ control }, { isRunning: false })
  const logService = { info() {}, warn(message) { errors.push(message) }, error(message) { errors.push(message) } }
  const deps = {
    getVault: () => native.decryptToken(JSON.parse(fs.readFileSync(control)).customMcpVault, root),
    setVault: (text) => {
      const config = JSON.parse(fs.readFileSync(control))
      config.customMcpVault = text
      fs.writeFileSync(control, JSON.stringify(config))
    },
  }
  const registry = { getAllManagers: () => [] }
  const load = () => new native.CustomMcpMainService(deps, registry, logService, {})
  const instance = load()
  const saved = JSON.parse(JSON.stringify(await instance.listSaved()))
  assert.deepEqual(saved.map((entry) => [entry.name, entry.source, entry.enabled]), [
    ["fixture-http", "custom", true], ["fixture-local", "custom", false],
  ])
  instance.applyToRunningRuntimes = async (server) => ({ state: server.enabled ? "saved" : "disabled" })
  instance.isOfficialBridge = () => false
  const disabled = await instance.setEnabled("fixture-http", false)
  assert.equal(disabled.ok, true, JSON.stringify(disabled))
  assert.equal((await load().listSaved()).find((entry) => entry.name === "fixture-http").enabled, false)
  assert.equal(syncMcpStore({ control }, { isRunning: false }).changed, false)
  assert.equal(readMcpVault(control).servers["fixture-http"].enabled, false)
  fs.writeFileSync(input, '{"mcp":{}}')
  syncMcpStore({ control }, { isRunning: false })
  assert.equal((await load().listSaved()).length, 0)
  assert.deepEqual(errors, [])
  console.log("PASS: installed Design decrypts saved MCPs, lists native custom records, persists its toggle across reload, and accepts withdrawal")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
