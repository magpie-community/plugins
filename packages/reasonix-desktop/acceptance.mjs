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
import { parseTOML as parse, stringify, parseEnv } from "./vendor.mjs"

const exec = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-reasonix-native-"))
const repo = fileURLToPath(new URL(".", import.meta.url))
const magpie = process.env.MAGPIE_BIN || "magpie"
const reasonix = process.env.REASONIX_BIN
const native = false
const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"), XDG_STATE_HOME: path.join(root, ".state"), REASONIX_HOME: path.join(root, ".reasonix"), REASONIX_STATE_HOME: path.join(root, ".reasonix-state"), MAGPIE_NO_ACCOUNTS: "1" }
const dz = env.REASONIX_HOME
const config = path.join(dz, "config.toml")
const control = path.join(dz, "magpie-agent.json")
const run = async (bin, args) => exec(bin, args, { cwd: root, env, timeout: 120000, maxBuffer: 2 << 20 })
let requests = 0
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
  assert.equal(body.model, "fixture/test-model")
  assert.equal(req.headers.authorization, `Bearer ${expectedKey}`)
  requests++
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
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "magpie/providers.json"), JSON.stringify({ providers: [{ id: "fixture", name: "Fixture", key: "fixture-only", chat: base, models: ["test-model"] }] }))
  await run(magpie, ["plugin", "add", native ? path.join(repo, "native") : repo])
  const agents = await run(magpie, ["agents"])
  assert.match(agents.stdout, /Reasonix 1\.x/)
  await run(magpie, ["reasonix-desktop", "fixture/test-model"])
  // Loading the real plugin host executes the companion bridge.
  const loaded = await run(magpie, ["plugin", "list", "--json"])
  assert.ok(!JSON.parse(loaded.stdout).loaded.some(plugin => plugin.error))
  assert.equal(parse(fs.readFileSync(config, "utf8")).default_model, "magpie-agent/fixture/test-model")
  console.log(`PASS: Magpie installs and discovers reasonix-desktop; ${native ? "native TOML support writes" : "its plugin host bridges"} the selected model`)
  if (reasonix) {
    expectedKey = parseEnv(fs.readFileSync(path.join(dz, ".env"))).MAGPIE_REASONIX_DESKTOP_API_KEY
    assert.ok(expectedKey)
    // Keep Magpie's selected ID and assigned key. Redirect only the isolated
    // control file to a local API fixture so no live gateway account is used.
    if (native) {
      const cfg = parse(fs.readFileSync(config, "utf8"))
      cfg.providers.find(p => p.name === "magpie-agent").base_url = base
      fs.writeFileSync(config, stringify(cfg))
    } else {
      const cfg = JSON.parse(fs.readFileSync(control, "utf8"))
      cfg.baseURL = base
      fs.writeFileSync(control, JSON.stringify(cfg))
      await run(process.execPath, [path.join(repo, "cli.mjs"), "sync"])
    }
    const result = await run(reasonix, ["-p", "Reply with bridge-ok", "--output-format", "json"])
    assert.ok(requests > 0)
    assert.match(result.stdout, /bridge-ok/)
    console.log("PASS: unchanged Reasonix sends its selected model and assigned credential to the local API")
  }
  await run(magpie, ["reasonix-desktop", "default"])
  if (!native) await run(process.execPath, [path.join(repo, "cli.mjs"), "sync"])
  if (reasonix) {
    // Reasonix may migrate its own config on startup. Those unrelated edits
    // belong to Reasonix and must survive the bridge's disconnect.
    const restored = parse(fs.readFileSync(config, "utf8"))
    assert.equal(restored.default_model, "mine/model")
    assert.deepEqual(restored.providers.map(p => p.name), ["mine"])
    assert.equal(restored.providers[0].base_url, "http://127.0.0.1:49998/v1")
  } else if (!native) {
    assert.equal(fs.readFileSync(config, "utf8"), original)
  }
  assert.equal(fs.readFileSync(path.join(dz, ".env"), "utf8"), "OTHER_KEY=fixture-original\n")
  console.log("PASS: disconnect restores the original selection and credentials, preserving Reasonix's own migrations")
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
