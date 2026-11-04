import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { parseTOML as parse, stringify, parseEnv } from "./vendor.mjs"
import { PROVIDER, KEY, syncBridge, startBridge } from "./bridge.mjs"
import { agent, connect } from "./reasonix-desktop.agent.js"

const originalConfig = `# User's comments and preferences
config_version = 12
default_model = "mine/model"
[agent]
compact_ratio = 0.8
[desktop]
provider_access = ["mine"]
[[providers]]
name = "mine"
kind = "openai"
base_url = "http://127.0.0.1:9999/v1"
models = ["model"]
api_key_env = "MY_API_KEY"
`
const originalEnv = "# existing secret\r\nMY_API_KEY=fixture-original\r\n"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-reasonix-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const p = { control: path.join(root, "magpie-agent.json"), config: path.join(root, "config.toml"), env: path.join(root, ".env"), state: path.join(root, ".magpie-bridge/state.json") }
  fs.writeFileSync(p.config, originalConfig)
  fs.writeFileSync(p.env, originalEnv)
  const select = (id = "vendor/model-v1", key = "fixture-gateway-key") => {
    const model = { id, context: 200000, output: 16000, images: true }
    fs.writeFileSync(p.control, JSON.stringify({ model: id, ...connect({ model, gateway: { v1: "http://127.0.0.1:3425/v1", key } }) }))
  }
  return { p, select, disconnect: () => fs.writeFileSync(p.control, "{}") }
}

test("agent descriptor and sandbox hook expose one selected model", () => {
  assert.equal(agent.id, "reasonix-desktop")
  assert.equal(agent.format, "json")
  assert.equal(agent.model, "model")
  assert.throws(() => connect({ gateway: {} }), /Choose a model/)
})

test("connect, switch, restart bridge, disconnect restores exact original bytes", t => {
  const { p, select, disconnect } = fixture(t)
  select()
  assert.equal(syncBridge(p), "connected")
  let cfg = parse(fs.readFileSync(p.config, "utf8"))
  assert.equal(cfg.default_model, "magpie-agent/vendor/model-v1")
  assert.equal(cfg.providers.length, 2)
  assert.deepEqual(cfg.providers[0], parse(originalConfig).providers[0])
  assert.equal(cfg.providers[1].model_overrides["vendor/model-v1"].vision, true)
  assert.deepEqual(cfg.desktop.provider_access, ["mine", PROVIDER])
  const env = parseEnv(fs.readFileSync(p.env))
  assert.equal(env.MY_API_KEY, "fixture-original")
  assert.equal(env[KEY], "fixture-gateway-key")
  assert.ok(!fs.readFileSync(p.config, "utf8").includes("fixture-gateway-key"))
  if (process.platform !== "win32") {
    for (const file of [p.state, p.control, p.config, p.env]) {
      if (file === p.control) continue // Magpie owns that file's permissions.
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
  }
  const before = fs.statSync(p.config).mtimeMs
  assert.equal(syncBridge(p), "connected")
  assert.equal(fs.statSync(p.config).mtimeMs, before)
  select("vendor/model-v2", "fixture-key-2")
  assert.equal(syncBridge(p), "connected")
  cfg = parse(fs.readFileSync(p.config, "utf8"))
  assert.equal(cfg.default_model, "magpie-agent/vendor/model-v2")
  assert.equal(cfg.providers.length, 2)
  disconnect()
  assert.equal(syncBridge(p), "disconnected")
  assert.equal(fs.readFileSync(p.config, "utf8"), originalConfig)
  assert.equal(fs.readFileSync(p.env, "utf8"), originalEnv)
  assert.ok(!fs.existsSync(p.state))
})

test("first installation and disconnect leave originally absent files absent", t => {
  const { p, select, disconnect } = fixture(t)
  fs.unlinkSync(p.config)
  fs.unlinkSync(p.env)
  select()
  syncBridge(p)
  disconnect()
  syncBridge(p)
  assert.ok(!fs.existsSync(p.config))
  assert.ok(!fs.existsSync(p.env))
})

test("unrelated edits during connection survive switching and disconnect", t => {
  const { p, select, disconnect } = fixture(t)
  select()
  syncBridge(p)
  const cfg = parse(fs.readFileSync(p.config, "utf8"))
  cfg.language = "zh"
  fs.writeFileSync(p.config, stringify(cfg))
  fs.appendFileSync(p.env, "NEW_SECRET=fixture-new\n")
  select("p/new")
  syncBridge(p)
  disconnect()
  syncBridge(p)
  assert.equal(parse(fs.readFileSync(p.config, "utf8")).language, "zh")
  assert.equal(parseEnv(fs.readFileSync(p.env)).NEW_SECRET, "fixture-new")
  assert.equal(parseEnv(fs.readFileSync(p.env)).MY_API_KEY, "fixture-original")
  assert.ok(!Object.hasOwn(parseEnv(fs.readFileSync(p.env)), KEY))
})

test("manual default and key edits are not overwritten", t => {
  const { p, select, disconnect } = fixture(t)
  select()
  syncBridge(p)
  const cfg = parse(fs.readFileSync(p.config, "utf8"))
  cfg.default_model = "mine/other"
  fs.writeFileSync(p.config, stringify(cfg))
  fs.appendFileSync(p.env, `${KEY}=manual-key\n`)
  assert.throws(() => syncBridge(p), /Default model was edited/)
  disconnect()
  syncBridge(p)
  assert.equal(parse(fs.readFileSync(p.config, "utf8")).default_model, "mine/other")
  assert.equal(parseEnv(fs.readFileSync(p.env))[KEY], "manual-key")
})

test("a conflicting provider is refused without writes", t => {
  const { p, select } = fixture(t)
  fs.writeFileSync(p.config, `[[providers]]\nname="${PROVIDER}"\nmodels=["manual"]\n`)
  const before = fs.readFileSync(p.config, "utf8")
  select()
  assert.throws(() => syncBridge(p), /already exists/)
  assert.equal(fs.readFileSync(p.config, "utf8"), before)
  assert.equal(fs.readFileSync(p.env, "utf8"), originalEnv)
})

test("existing bridge-named credentials and references are never taken over", t => {
  const { p, select } = fixture(t)
  select()
  const conflict = originalEnv + `${KEY}=fixture-user-key\n`
  fs.writeFileSync(p.env, conflict)
  assert.throws(() => syncBridge(p), /credential name already belongs/)
  assert.equal(fs.readFileSync(p.config, "utf8"), originalConfig)
  assert.equal(fs.readFileSync(p.env, "utf8"), conflict)
  fs.writeFileSync(p.env, originalEnv)
  const cfg = parse(originalConfig)
  cfg.providers[0].api_key_env = KEY
  const referenced = stringify(cfg)
  fs.writeFileSync(p.config, referenced)
  assert.throws(() => syncBridge(p), /credential name already belongs/)
  assert.equal(fs.readFileSync(p.config, "utf8"), referenced)
  assert.equal(fs.readFileSync(p.env, "utf8"), originalEnv)
})

test("invalid TOML and incomplete connection do not touch configuration or credentials", t => {
  const { p, select } = fixture(t)
  select()
  fs.writeFileSync(p.config, "default_model = [broken")
  assert.throws(() => syncBridge(p))
  assert.equal(fs.readFileSync(p.env, "utf8"), originalEnv)
  assert.ok(!fs.existsSync(p.state))
  fs.writeFileSync(p.config, originalConfig)
  fs.writeFileSync(p.control, JSON.stringify({ baseURL: "http://localhost/v1" }))
  assert.throws(() => syncBridge(p), /Incomplete/)
  assert.equal(fs.readFileSync(p.config, "utf8"), originalConfig)
})

test("interrupted journal recovers, but external edits stop recovery before writes", t => {
  const { p, select } = fixture(t)
  select()
  syncBridge(p)
  const state = JSON.parse(fs.readFileSync(p.state, "utf8"))
  const nextEnv = state.lastEnv + "EXTRA=ok\n"
  const pending = { state: { ...state, lastEnv: nextEnv }, changes: [{ file: p.env, before: state.lastEnv, after: nextEnv }, { file: p.config, before: state.originalConfig, after: state.lastConfig }] }
  fs.writeFileSync(p.state + ".pending", JSON.stringify(pending))
  fs.writeFileSync(p.env, nextEnv)
  syncBridge(p)
  assert.ok(!fs.existsSync(p.state + ".pending"))
  fs.writeFileSync(p.state + ".pending", JSON.stringify(pending))
  fs.writeFileSync(p.config, "language='changed'\n")
  assert.throws(() => syncBridge(p), /recovery paused/)
  assert.equal(fs.readFileSync(p.config, "utf8"), "language='changed'\n")
})

test("symlinked target is refused", { skip: process.platform === "win32" }, t => {
  const { p, select } = fixture(t)
  fs.renameSync(p.config, p.config + ".real")
  fs.symlinkSync(p.config + ".real", p.config)
  select()
  assert.throws(() => syncBridge(p), /non-regular/)
  assert.equal(fs.readFileSync(p.config + ".real", "utf8"), originalConfig)
})

test("polling bridge follows selection and shuts down cleanly", async t => {
  const { p, select, disconnect } = fixture(t)
  let errors = 0
  const stop = startBridge(p, { interval: 20, onError: () => errors++ })
  t.after(stop)
  select()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(parse(fs.readFileSync(p.config, "utf8")).default_model, "magpie-agent/vendor/model-v1")
  disconnect()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(fs.readFileSync(p.config, "utf8"), originalConfig)
  assert.equal(errors, 0)
})

test("normal host exit flushes a disconnect and leaves an active connection configured", t => {
  const plugin = new URL("./index.mjs", import.meta.url).href
  for (const disconnect of [true, false]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-host-exit-"))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const dir = path.join(home, ".reasonix")
    fs.mkdirSync(dir)
    const config = path.join(dir, "config.toml")
    const envFile = path.join(dir, ".env")
    const control = path.join(dir, "magpie-agent.json")
    fs.writeFileSync(config, originalConfig)
    fs.writeFileSync(envFile, originalEnv)
    fs.writeFileSync(control, JSON.stringify({ model: "fixture/model", baseURL: "http://127.0.0.1:3425/v1", gatewayKey: "fixture-assigned-key" }))
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import plugin from ${JSON.stringify(plugin)};
      await plugin();
      ${disconnect ? `fs.writeFileSync(${JSON.stringify(control)}, "{}");` : ""}
      process.exit(0);
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10000, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    if (disconnect) {
      assert.equal(fs.readFileSync(config, "utf8"), originalConfig)
      assert.equal(fs.readFileSync(envFile, "utf8"), originalEnv)
    } else {
      assert.equal(parse(fs.readFileSync(config, "utf8")).default_model, "magpie-agent/fixture/model")
      assert.equal(parseEnv(fs.readFileSync(envFile))[KEY], "fixture-assigned-key")
    }
  }
})
