import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"

const app = process.env.MINIMAX_APP
if (!app) throw new Error("Set MINIMAX_APP for bundled plugin-loader validation.")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-mcp-loader-"))
const configDir = path.join(root, "config/opencode")
fs.mkdirSync(configDir, { recursive: true })
const pluginDir = path.join(root, "bridge")
fs.mkdirSync(pluginDir)
fs.cpSync(new URL("./runtime", import.meta.url), path.join(pluginDir, "runtime"), { recursive: true })
fs.copyFileSync(new URL("./mcp-sync.mjs", import.meta.url), path.join(pluginDir, "mcp-sync.mjs"))
fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ type: "module", main: "./index.mjs" }))
fs.writeFileSync(path.join(pluginDir, "index.mjs"), 'throw new Error("Wrong companion entry loaded")')
const runtimePlugin = new URL(`file://${pluginDir}/runtime/mcp-runtime.mjs`).href
fs.mkdirSync(path.join(configDir, "node_modules"))
fs.writeFileSync(path.join(configDir, "package-lock.json"), JSON.stringify({
  lockfileVersion: 3, packages: { "": { dependencies: { "@opencode-ai/plugin": "1.18.18" } } },
}))
fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
  plugin: [runtimePlugin],
  mcp: { probe: { type: "remote", url: "http://127.0.0.1:1/mcp" } },
}))
const registrations = []
const gateway = http.createServer(async (request, response) => {
  if (request.url === "/v1/chat/completions") {
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
    } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }))
    return
  }
  if (!request.url.startsWith("/api/")) { response.writeHead(404).end(); return }
  if (request.method === "POST") {
    let text = ""
    for await (const chunk of request) text += chunk
    registrations.push(JSON.parse(text))
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
    request.method === "GET" ? { servers: {} } : { status: "connected" },
  ))
})
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve))
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const gatewayURL = `http://127.0.0.1:${gateway.address().port}`
const runtimeURL = `http://127.0.0.1:${port}`
const configFile = path.join(configDir, "opencode.json")
const config = JSON.parse(fs.readFileSync(configFile))
config.provider = { fixture: {
  npm: "@ai-sdk/openai-compatible", name: "Fixture",
  options: { baseURL: `${gatewayURL}/v1`, apiKey: "fixture" },
  models: { probe: { name: "probe", tool_call: true, limit: { context: 8000, output: 1000 } } },
} }
fs.writeFileSync(configFile, JSON.stringify(config))
let logs = ""
const child = spawn(path.join(app, "Contents/Resources/opencode/opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: {
    ...process.env, HOME: root, OPENCODE_TEST_HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    BUN_CONFIG_REGISTRY: gatewayURL, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
    HILO_AGENT_PROFILE_VERSION: "3", GATEWAY_URL: gatewayURL, HILO_WORKSPACE_CLAIM: "fixture",
    HILO_WORKSPACE_INSTANCE_ID: "fixture", HILO_WORKSPACE_GENERATION: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }, stdio: ["ignore", "pipe", "pipe"],
})
child.stdout.on("data", (chunk) => { logs += chunk })
child.stderr.on("data", (chunk) => { logs += chunk })
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(logs)
    try {
      ready = (await fetch(`${runtimeURL}/global/health`, { signal: AbortSignal.timeout(200) })).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, logs)
  const initialized = await fetch(`${runtimeURL}/experimental/tool/ids`, { signal: AbortSignal.timeout(45000) })
  assert.equal(initialized.status, 200)
  await initialized.body?.cancel()
  const session = await (await fetch(`${runtimeURL}/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).json()
  assert.ok(session.id)
  const turn = await fetch(`${runtimeURL}/session/${session.id}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "fixture", modelID: "probe" }, parts: [{ type: "text", text: "loader fixture" }] }),
    signal: AbortSignal.timeout(20000),
  })
  await turn.body?.cancel()
  await new Promise((resolve) => setTimeout(resolve, 5500))
  assert.ok(registrations.some((entry) => entry.name === "probe"), logs)
  const status = await (await fetch(`${runtimeURL}/mcp`)).json()
  assert.equal(status.probe.status, "disabled")
  console.log("PASS: bundled OpenCode loads the bridge, disables direct MCP and registers with the V3 gateway")
} finally {
  child.kill("SIGKILL")
  gateway.close()
  console.log(`Loader sandbox: ${root}`)
}
