import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createMcpBridge, installMcpBridge } from "./mcp-sync.mjs"

test("bridge installs once and preserves Library and unrelated plugins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-mcp-"))
  try {
    const file = path.join(root, "ai-runtime/config-home/opencode/opencode.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ plugin: ["mine"], mcp: { mine: { enabled: false } } }))
    installMcpBridge(path.join(root, "hub-config.json"))
    installMcpBridge(path.join(root, "hub-config.json"))
    const config = JSON.parse(fs.readFileSync(file))
    assert.equal(config.plugin.length, 2)
    assert.equal(config.plugin[0], "mine")
    assert.match(config.plugin[1], /mcp-runtime\.mjs$/)
    assert.deepEqual(config.mcp, { mine: { enabled: false } })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("V3 registration survives empty native registry, isolates secrets, updates and withdraws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-mcp-"))
  try {
    const file = path.join(root, "opencode.json")
    const remote = { type: "remote", url: "http://127.0.0.1:3425/mcp" }
    const write = (mcp) => fs.writeFileSync(file, JSON.stringify({ mcp }))
    write({ hub: remote, docs: { type: "local", command: ["node", "mcp.js"] } })
    let servers = {}
    const calls = []
    const bridge = createMcpBridge({ file, serverUrl: new URL("http://127.0.0.1:4321/"),
      env: { GATEWAY_URL: "http://127.0.0.1:8002", HILO_WORKSPACE_CLAIM: "claim", HILO_WORKSPACE_INSTANCE_ID: "instance",
        HILO_WORKSPACE_GENERATION: "1", HILO_USER_TOKEN: "private", PATH: "/bin" },
      request: async (url, options) => {
        assert.equal(options.headers["x-hilo-workspace"], "claim")
        if (url.pathname.endsWith("proxy-status")) return Response.json({ servers })
        const body = JSON.parse(options.body)
        calls.push(body)
        assert.equal(body.expectedRuntimeUrl, "http://127.0.0.1:4321")
        const status = body.config.enabled === false ? "disabled" : "connected"
        servers[body.name] = { status }
        return Response.json({ status })
      },
    })
    const config = { mcp: { hub: remote, design: { type: "local", enabled: true } } }
    bridge.config(config)
    assert.equal(config.mcp.hub.enabled, false)
    assert.equal(config.mcp.design.enabled, true)
    await bridge.sync()
    assert.equal(calls.length, 2)
    assert.equal(calls.find((entry) => entry.name === "docs").config.environment.HILO_USER_TOKEN, "")
    assert.equal(calls.find((entry) => entry.name === "docs").config.environment.OPENCODE_CONFIG_CONTENT, "")
    await bridge.sync()
    assert.equal(calls.length, 2)
    servers = {}
    await bridge.sync()
    assert.equal(calls.length, 4)
    write({ hub: { ...remote, enabled: false } })
    await bridge.sync()
    assert.equal(servers.hub.status, "disabled")
    assert.equal(servers.docs.status, "disabled")
    const before = calls.length
    await bridge.sync()
    assert.equal(calls.length, before)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("one unreachable MCP does not prevent other native registrations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-mcp-"))
  try {
    const file = path.join(root, "opencode.json")
    fs.writeFileSync(file, JSON.stringify({ mcp: {
      eagle: { type: "remote", url: "http://127.0.0.1:41596/mcp" },
      hub: { type: "remote", url: "http://127.0.0.1:3425/mcp" },
    } }))
    const calls = []
    const bridge = createMcpBridge({ file, serverUrl: "http://127.0.0.1:4321",
      env: { GATEWAY_URL: "http://127.0.0.1:8002", HILO_WORKSPACE_CLAIM: "claim",
        HILO_WORKSPACE_INSTANCE_ID: "instance", HILO_WORKSPACE_GENERATION: "1" },
      request: async (url, options) => {
        if (url.pathname.endsWith("proxy-status")) return Response.json({ servers: {} })
        const { name } = JSON.parse(options.body)
        calls.push(name)
        return Response.json({ status: name === "eagle" ? "failed" : "connected" })
      },
    })
    await assert.rejects(bridge.sync(), /eagle/)
    assert.deepEqual(calls.sort(), ["eagle", "hub"])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
