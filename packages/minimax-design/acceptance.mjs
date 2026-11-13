import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import vm from "node:vm"

const exec = promisify(execFile)
const magpie = process.env.MAGPIE_BIN
const app = process.env.MINIMAX_APP
if (!magpie || !app) throw new Error("Set MAGPIE_BIN and MINIMAX_APP for native macOS acceptance.")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-design-acceptance-"))
const packageDir = process.env.MINIMAX_PLUGIN_DIR ?? fileURLToPath(new URL(".", import.meta.url))
const resources = path.join(app, "Contents/Resources")
const data = path.join(root, "Library/Application Support/@hilo/desktop")
const settings = path.join(root, ".config/magpie")
const configFile = path.join(data, "hub-config.json")
const runtimeConfigHome = path.join(data, "ai-runtime/config-home")
const mcpFile = path.join(runtimeConfigHome, "opencode/opencode.json")
const skillName = "magpie-native-probe"
const skill = path.join(root, "Movies/Hub/skills", skillName, "SKILL.md")
const env = {
  ...process.env, HOME: root, USERPROFILE: root,
  XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"),
  XDG_STATE_HOME: path.join(root, ".state"), MAGPIE_NO_ACCOUNTS: "1",
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "localhost,127.0.0.1",
}
const children = []
const logs = []
const run = async (bin, args, extraEnv = {}) =>
  exec(bin, args, { cwd: root, env: { ...env, ...extraEnv }, timeout: 30000, maxBuffer: 4 << 20 })
const start = (bin, args, extraEnv = {}) => {
  const child = spawn(bin, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] })
  children.push(child)
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()))
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()))
  return child
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const freePort = async () => {
  const server = http.createServer()
  await listen(server)
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Runtime exited: ${logs.join("").slice(-5000)}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) return response
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Runtime did not become ready: ${url}\n${logs.join("").slice(-5000)}`)
}
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}
let inferenceRequests = 0
let toolCalls = 0
let toolResults = 0
const fixture = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  let raw = ""
  for await (const chunk of request) raw += chunk
  if (request.url === "/mcp") {
    if (request.method !== "POST") { response.writeHead(405).end(); return }
    const message = JSON.parse(raw)
    if (message.id === undefined) { response.writeHead(202).end(); return }
    let result
    if (message.method === "initialize") result = {
      protocolVersion: "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "minimax-fixture", version: "1.0.0" },
    }
    else if (message.method === "tools/list") result = {
      tools: [{ name: "probe", description: "Return the native acceptance marker", inputSchema: { type: "object", properties: {} } }],
    }
    else if (message.method === "tools/call") {
      toolCalls++
      result = { content: [{ type: "text", text: "minimax-mcp-ok" }] }
    } else result = {}
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    return
  }
  if (request.method === "GET") {
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4.1", object: "model" }] }))
    return
  }
  const body = JSON.parse(raw)
  assert.equal(body.model, "gpt-4.1")
  inferenceRequests++
  const toolResult = body.messages.some((message) => message.role === "tool" && String(message.content).includes("minimax-mcp-ok"))
  if (toolResult) toolResults++
  const tool = body.tools?.find((entry) => entry.function?.name.includes("probe"))
  const call = tool && !toolResult
    ? [{ id: "native-probe-call", type: "function", function: { name: tool.function.name, arguments: "{}" } }]
    : undefined
  const reply = {
    id: `fixture-${inferenceRequests}`, object: "chat.completion", model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: call ? null : "minimax-model-ok", ...(call ? { tool_calls: call } : {}) }, finish_reason: call ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }
  if (body.stream) {
    response.setHeader("content-type", "text/event-stream")
    const delta = call
      ? { role: "assistant", tool_calls: call.map((entry, index) => ({ index, ...entry })) }
      : { role: "assistant", content: "minimax-model-ok" }
    response.end(`data: ${JSON.stringify({ ...reply, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...reply, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`)
  } else response.end(JSON.stringify(reply))
})

try {
  await listen(fixture)
  const fixtureURL = `http://127.0.0.1:${fixture.address().port}`
  const gatewayPort = await freePort()
  env.MAGPIE_ADDR = `127.0.0.1:${gatewayPort}`
  const original = {
    _version: 33, config: { theme: "native-fixture", customModels: { "user-custom-mine": { untouched: true } } },
    customMcpVault: "fixture-vault-left-alone",
  }
  writeJSON(configFile, original)
  writeJSON(path.join(settings, "plugins.json"), { plugins: [{ spec: packageDir }] })
  writeJSON(path.join(settings, "providers.json"), {
    providers: [{ id: "fixture", name: "Fixture", key: "fixture-only", chat: `${fixtureURL}/v1`, models: ["gpt-4.1"], catalog: "openai" }],
  })
  const librarySkill = path.join(settings, "library/skills", skillName, "SKILL.md")
  fs.mkdirSync(path.dirname(librarySkill), { recursive: true })
  fs.writeFileSync(librarySkill, `---\nname: ${skillName}\ndescription: Native MiniMax acceptance marker\n---\nReturn minimax-skill-ok.\n`)
  writeJSON(path.join(settings, "library.json"), {
    skills: [{ name: skillName, agents: ["minimax-design"] }], mcp: [], applied: {},
  })
  const listing = await run(magpie, ["minimax-design"])
  assert.match(listing.stdout, /MiniMax Design/)
  await run(magpie, ["minimax-design", "provider", "magpie"])
  const connected = JSON.parse(fs.readFileSync(configFile))
  assert.deepEqual(connected.config.customModels["user-custom-mine"], { untouched: true })
  const provider = connected.config.customModels["user-custom-magpie"]
  assert.equal(provider.baseUrl, `http://127.0.0.1:${gatewayPort}/v1`)
  assert.equal(provider.models[0].id, "fixture/gpt-4.1")
  console.log("PASS: real Magpie sandbox discovers and connects MiniMax Design, preserving unrelated configuration")

  const archive = fs.readFileSync(path.join(resources, "app.asar"))
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)))
  const base = 8 + archive.readUInt32LE(4)
  let nativeSource
  for (const entry of Object.values(header.files.out.files.main.files.chunks.files)) {
    const text = archive.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size).toString()
    if (text.includes("function getCustomModelValidationErrors(")) { nativeSource = text; break }
  }
  assert.ok(nativeSource)
  const begin = nativeSource.indexOf("function getCustomModelValidationErrors(")
  const end = nativeSource.indexOf("function validateCustomModelInput", begin)
  const validate = vm.runInNewContext(`(${nativeSource.slice(begin, end)})`, { URL })
  for (const entry of Object.values(connected.config.customModels).filter((entry) => entry.providerName === "Magpie")) {
    assert.deepEqual(Object.keys(validate(entry)), [])
  }
  console.log("PASS: Design 4.0.10's own model validator accepts Magpie's generated configuration")

  writeJSON(mcpFile, { mcp: { mine: { type: "remote", url: `${fixtureURL}/mine`, enabled: false } }, instructions: [] })
  await run(magpie, ["library", "sync"])
  assert.match(fs.readFileSync(skill, "utf8"), /minimax-skill-ok/)
  await run(magpie, ["library", "mcp", "add", "magpie-probe", `${fixtureURL}/mcp`, "agents=minimax-design"])
  const mcp = JSON.parse(fs.readFileSync(mcpFile))
  assert.equal(mcp.mcp["magpie-probe"].type, "remote")
  assert.equal(mcp.mcp.mine.enabled, false)
  assert.equal(JSON.parse(fs.readFileSync(configFile)).customMcpVault, original.customMcpVault)
  console.log("PASS: Magpie Library distributes the skill and MCP server while preserving existing MCP and encrypted-vault data")

  const desktopPort = await freePort()
  const desktop = start(path.join(app, "Contents/MacOS/MiniMax Design"),
    [path.join(resources, "gateway/dist/main.js")], {
      ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production",
      HILO_RELEASE_REGION: "domestic", HILO_RELEASE_CHANNEL: "prod",
      HILO_GATEWAY_ROLE: "app-level", PORT: String(desktopPort), OUTPUT_DIR: path.join(root, "output"),
      OPENCODE_CONFIG_DIR: path.join(resources, "agent-profiles/v3/config"),
    })
  const desktopURL = `http://127.0.0.1:${desktopPort}`
  const skills = await (await ready(`${desktopURL}/api/skills`, desktop)).json()
  assert.ok(skills.some((entry) => entry.name === skillName && entry.source === "user"))
  const enabled = await fetch(`${desktopURL}/api/skills/${skillName}/toggle`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  const enabledSkills = await (await fetch(`${desktopURL}/api/skills`)).json()
  assert.equal(enabledSkills.find((entry) => entry.name === skillName).enabled, true)
  console.log("PASS: Design's actual gateway discovers the Library skill and enables it through its normal skill-permission API")

  const runtimeEnv = {
    OPENCODE_TEST_HOME: path.join(data, "ai-runtime/home"),
    XDG_CONFIG_HOME: runtimeConfigHome, XDG_DATA_HOME: path.join(data, "ai-runtime/data-home"),
    XDG_CACHE_HOME: path.join(data, "ai-runtime/cache-home"), XDG_STATE_HOME: path.join(data, "ai-runtime/state-home"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: { [provider.providerName.toLowerCase()]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: provider.baseUrl, apiKey: provider.apiKey },
        models: { "fixture/gpt-4.1": { id: "fixture/gpt-4.1", limit: { context: provider.models[0].contextWindow, output: provider.models[0].maxOutputTokens } } },
      } },
      mcp: { bundled: { type: "remote", url: `${fixtureURL}/bundled`, enabled: false } },
    }),
  }
  const opencode = path.join(resources, "opencode/opencode")
  const resolved = JSON.parse((await run(opencode, ["debug", "config", "--pure"], runtimeEnv)).stdout)
  assert.ok(resolved.mcp["magpie-probe"])
  assert.ok(resolved.mcp.bundled)
  assert.ok(resolved.mcp.mine)
  const runtimePort = await freePort()
  const runtime = start(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(runtimePort)], runtimeEnv)
  const runtimeURL = `http://127.0.0.1:${runtimePort}`
  await ready(`${runtimeURL}/global/health`, runtime)
  const status = await (await fetch(`${runtimeURL}/mcp`)).json()
  assert.equal(status["magpie-probe"].status, "connected")
  console.log("PASS: Design's bundled OpenCode loads and connects the Library MCP alongside bundled and user servers")

  const gateway = start(magpie, ["serve"])
  await ready(`http://127.0.0.1:${gatewayPort}/v1/models`, gateway)
  const completion = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model: provider.models[0].id, messages: [{ role: "user", content: "native acceptance" }] }),
  })
  assert.equal(completion.status, 200)
  assert.equal((await completion.json()).choices[0].message.content, "minimax-model-ok")
  assert.ok(inferenceRequests > 0)
  console.log("PASS: the generated provider key and model route a real request through sandbox Magpie to the localhost model fixture")

  const session = await (await fetch(`${runtimeURL}/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).json()
  assert.ok(session.id)
  const turn = await fetch(`${runtimeURL}/session/${session.id}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "magpie", modelID: "fixture/gpt-4.1" },
      parts: [{ type: "text", text: "Call the probe tool once and return its result." }],
    }),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(turn.status, 200)
  const answer = await turn.json()
  assert.ok(toolCalls > 0, JSON.stringify(answer))
  assert.ok(toolResults > 0, JSON.stringify(answer))
  console.log("PASS: Design's bundled agent completes an actual model → Magpie → MCP tool → model turn")

  await run(magpie, ["library", "mcp", "agents", "magpie-probe", "none"])
  await run(magpie, ["library", "skill", "agents", skillName, "none"])
  assert.equal(JSON.parse(fs.readFileSync(mcpFile)).mcp["magpie-probe"], undefined)
  assert.ok(JSON.parse(fs.readFileSync(mcpFile)).mcp.mine)
  assert.equal(fs.existsSync(skill), false)
  const afterSkills = await (await fetch(`${desktopURL}/api/skills`)).json()
  assert.equal(afterSkills.some((entry) => entry.name === skillName), false)
  await run(magpie, ["minimax-design", "default"])
  const disconnected = JSON.parse(fs.readFileSync(configFile))
  assert.deepEqual(disconnected.config.customModels, original.config.customModels)
  assert.equal(disconnected.config.theme, original.config.theme)
  console.log("PASS: disabling Library items and disconnecting removes only Magpie's entries")

  const catalog = Array.from({ length: 101 }, (_, index) => `fixture/model-${index}`)
  writeJSON(path.join(settings, "providers.json"), {
    providers: [{ id: "fixture", name: "Fixture", key: "fixture-only",
      chat: `${fixtureURL}/v1`, models: catalog.map((entry) => entry.slice("fixture/".length)),
      contexts: { "*": 128000 } }],
  })
  const settingsFile = path.join(settings, "settings.json")
  const savedSettings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile)) : {}
  savedSettings.modelOutputs = { "fixture/*": 16000 }
  writeJSON(settingsFile, savedSettings)
  await run(magpie, ["minimax-design", "provider", "magpie"])
  const split = Object.entries(JSON.parse(fs.readFileSync(configFile)).config.customModels)
    .filter(([name]) => name.startsWith("user-custom-magpie"))
  assert.deepEqual(split.map(([, value]) => value.models.length).sort((left, right) => left - right), [1, 50, 50])
  assert.equal(split.flatMap(([, value]) => value.models).length, 101)
  const changedProviderFile = JSON.parse(fs.readFileSync(path.join(settings, "providers.json")))
  changedProviderFile.providers[0].models = ["model-0"]
  writeJSON(path.join(settings, "providers.json"), changedProviderFile)
  await run(magpie, ["minimax-design", "provider", "magpie"])
  const shrunk = JSON.parse(fs.readFileSync(configFile)).config.customModels
  assert.equal(shrunk["user-custom-magpie"].models.length, 1)
  assert.equal(shrunk["user-custom-magpie-2"], undefined)
  assert.equal(shrunk["user-custom-magpie-3"], undefined)
  await run(magpie, ["minimax-design", "default"])
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).config.customModels, original.config.customModels)
  console.log("PASS: a 101-model catalog is split without loss and obsolete groups disappear after a shrink")
  console.log(`Native acceptance passed. Sandbox: ${root}`)
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 3000)
        child.once("exit", () => { clearTimeout(timer); resolve() })
      })
    }
  }
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
