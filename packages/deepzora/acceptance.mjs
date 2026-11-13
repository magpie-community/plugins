// Optional native acceptance. Everything uses disposable homes and a localhost
// model fixture: no user config, subscription credentials or paid model calls.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { parseTOML as parse, parseEnv } from "./vendor.mjs"

const exec = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-deepzora-native-"))
const repo = fileURLToPath(new URL(".", import.meta.url))
const magpie = process.env.MAGPIE_BIN || "magpie"
const deepzora = process.env.DEEPZORA_BIN
const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"), XDG_STATE_HOME: path.join(root, ".state"), DEEPZORA_HOME: path.join(root, ".deepzora"), DEEPZORA_STATE_HOME: path.join(root, ".deepzora-state"), MAGPIE_NO_ACCOUNTS: "1" }
const dz = env.DEEPZORA_HOME
const config = path.join(dz, "config.toml")
const control = path.join(dz, "magpie-agent.json")
const run = async (bin, args) => exec(bin, args, { cwd: root, env, timeout: 120000, maxBuffer: 2 << 20 })
const requestedModels = new Set()
let expectedKey = ""
const server = http.createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ object: "list", data: [{ id: "fixture/test-model", object: "model" }] }))
    return
  }
  const body = JSON.parse(raw)
  assert.equal(req.url, "/v1/chat/completions")
  assert.ok(["fixture/test-model", "ollama-cloud/second"].includes(body.model))
  assert.equal(req.headers.authorization, `Bearer ${expectedKey}`)
  requestedModels.add(body.model)
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream")
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "bridge-ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
  } else {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ id: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "bridge-ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
  }
})

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}/v1`
  fs.mkdirSync(dz, { recursive: true })
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "magpie"), { recursive: true })
  const original = '# native acceptance fixture\ndefault_model="mine/model"\n[[providers]]\nname="mine"\nkind="openai"\nbase_url="http://127.0.0.1:49998/v1"\nmodels=["model"]\n'
  fs.writeFileSync(config, original)
  fs.writeFileSync(path.join(dz, ".env"), "OTHER_KEY=fixture-original\n")
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "magpie/providers.json"), JSON.stringify({ providers: [
    { id: "fixture", name: "Fixture", key: "fixture-only", chat: base, models: ["test-model"] },
    { id: "ollama-cloud", name: "Ollama Cloud", key: "fixture-only", chat: base, models: ["second"] },
  ] }))
  await run(magpie, ["plugin", "add", repo])
  const agents = await run(magpie, ["agents"])
  assert.match(agents.stdout, /Deepzora/)
  await run(magpie, ["deepzora", "fixture/test-model"])
  // Loading the real plugin host executes the companion bridge.
  const loaded = await run(magpie, ["plugin", "list", "--json"])
  assert.ok(!JSON.parse(loaded.stdout).loaded.some(plugin => plugin.error))
  assert.equal(parse(fs.readFileSync(config, "utf8")).default_model, "magpie-agent/fixture/test-model")
  assert.ok(parse(fs.readFileSync(config, "utf8")).providers.find(p => p.name === "magpie-agent").models.includes("ollama-cloud/second"))
  console.log("PASS: Magpie's plugin host imports the unselected Ollama route and keeps the selected default")
  if (deepzora) {
    expectedKey = parseEnv(fs.readFileSync(path.join(dz, ".env"))).MAGPIE_DEEPZORA_API_KEY
    assert.ok(expectedKey)
    // Keep Magpie's selected ID and assigned key. Redirect only the isolated
    // control file to a local API fixture so no live gateway account is used.
    const cfg = JSON.parse(fs.readFileSync(control, "utf8"))
    cfg.baseURL = base
    fs.writeFileSync(control, JSON.stringify(cfg))
    await run(process.execPath, [path.join(repo, "cli.mjs"), "sync"])
    const result = await run(deepzora, ["-p", "Reply with bridge-ok", "--output-format", "json"])
    assert.ok(requestedModels.has("fixture/test-model"))
    assert.match(result.stdout, /bridge-ok/)
    const other = await run(deepzora, ["--model", "magpie-agent/ollama-cloud/second", "-p", "Reply with bridge-ok", "--output-format", "json"])
    assert.match(other.stdout, /bridge-ok/)
    assert.ok(requestedModels.has("ollama-cloud/second"))
    console.log("PASS: unchanged Deepzora routes both the default and an imported Ollama model to the local API")
  }
  await run(magpie, ["deepzora", "default"])
  await run(process.execPath, [path.join(repo, "cli.mjs"), "sync"])
  if (deepzora) {
    // Deepzora may migrate its config on startup; keep those unrelated edits.
    const restored = parse(fs.readFileSync(config, "utf8"))
    assert.equal(restored.default_model, "mine/model")
    assert.deepEqual(restored.providers.map(p => p.name), ["mine"])
    assert.equal(restored.providers[0].base_url, "http://127.0.0.1:49998/v1")
  } else {
    assert.equal(fs.readFileSync(config, "utf8"), original)
  }
  assert.equal(fs.readFileSync(path.join(dz, ".env"), "utf8"), "OTHER_KEY=fixture-original\n")
  console.log("PASS: disconnect restores selection and credentials, preserving unrelated Deepzora edits")
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
