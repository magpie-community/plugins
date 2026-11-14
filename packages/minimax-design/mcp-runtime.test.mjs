import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import plugin from "./runtime/mcp-runtime.mjs"

test("runtime bridge stays available until local save and cleanup complete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-runtime-migration-"))
  const saved = { ...process.env }
  t.after(() => {
    process.env = saved
    fs.rmSync(root, { recursive: true, force: true })
  })
  const configHome = path.join(root, "ai-runtime/config-home")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    mcp: { probe: { type: "remote", url: "https://example.invalid/mcp" } },
  }))
  fs.writeFileSync(path.join(root, "library-mcp.json"), '{"mcp":{}}')
  Object.assign(process.env, {
    XDG_CONFIG_HOME: configHome, HILO_AGENT_PROFILE_VERSION: "3",
    GATEWAY_URL: "http://127.0.0.1:8002", HILO_WORKSPACE_CLAIM: "fixture",
    HILO_WORKSPACE_INSTANCE_ID: "fixture", HILO_WORKSPACE_GENERATION: "1",
  })
  const ownership = path.join(root, ".magpie-mcp/ownership.json")
  fs.mkdirSync(path.dirname(ownership))
  for (const state of [null, { servers: {} }, { servers: {}, nativeReady: false }]) {
    if (state) fs.writeFileSync(ownership, JSON.stringify(state))
    const hooks = await plugin({ serverUrl: "http://127.0.0.1:4321" })
    t.after(() => hooks.dispose?.())
    assert.equal(typeof hooks.config, "function")
    const config = { mcp: { probe: { enabled: true } } }
    await hooks.config(config)
    assert.equal(config.mcp.probe.enabled, false)
    await hooks.dispose()
  }
  fs.writeFileSync(ownership, JSON.stringify({ servers: {}, nativeReady: true }))
  assert.deepEqual(await plugin({ serverUrl: "http://127.0.0.1:4321" }), {})
})
