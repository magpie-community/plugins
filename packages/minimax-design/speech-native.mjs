import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { applyMedia, mediaPaths } from "./media-sync.mjs"

const { MAGPIE_BIN: magpie, MAGPIE_BUN: bun, MINIMAX_APP: app } = process.env
if (!magpie || !bun || !app) throw new Error("Set MAGPIE_BIN, MAGPIE_BUN and MINIMAX_APP for native speech validation.")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-speech-"))
const env = { ...process.env, HOME: root, USERPROFILE: root, T3CODE_HOME: path.join(root, ".t3"),
  XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"),
  XDG_STATE_HOME: path.join(root, ".state"), XDG_DATA_HOME: path.join(root, ".local/share"),
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "localhost,127.0.0.1" }
const ids = ["mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit", "mimo-v2.5-tts-voicedesign"]
const sent = []
const upstream = http.createServer(async (req, res) => {
  if (req.url !== "/v1/audio/speech" || req.method !== "POST") { res.writeHead(404).end(); return }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  sent.push(JSON.parse(Buffer.concat(chunks)))
  const error = sent.at(-1).instructions === "missing voice"
    ? { error: { message: "voice_not_found: choose another voice", code: "voice_not_found" } }
    : { detail: { message: "speech budget exhausted", code: "insufficient_quota" } }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(error))
})
let daemon
try {
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const reserve = http.createServer().listen(0, "127.0.0.1")
  await once(reserve, "listening")
  const address = `127.0.0.1:${reserve.address().port}`
  await new Promise(resolve => reserve.close(resolve))
  const config = path.join(env.XDG_CONFIG_HOME, "magpie")
  await fs.mkdir(config, { recursive: true })
  await fs.writeFile(path.join(config, "providers.json"), JSON.stringify({ providers: [{ id: "mlx-audio-tools",
    name: "Speech fixture", key: "fixture-only", chat: `http://127.0.0.1:${upstream.address().port}/v1`, models: ids }] }))
  const gateway = { baseURL: `http://${address}/v1`, key: "magpie-minimax-design" }
  daemon = spawn(magpie, ["serve"], { cwd: root, env: { ...env, MAGPIE_ADDR: address }, stdio: "ignore" })
  const paths = mediaPaths(root, "darwin")
  applyMedia(paths, gateway, ids.map(name => ({ ref: `mlx-audio-tools/${name}`, type: "speech", name })))
  const { models } = JSON.parse(await fs.readFile(path.join(paths.store, "config.json")))
  const jobs = await Promise.all(models.map(async model => ({ model: model.upstreamModel,
    source: await fs.readFile(path.join(paths.store, "models", model.id, "adapter.js"), "utf8") })))
  const dist = path.join(app, "Contents/Resources/gateway")
  const runtime = await fs.readFile(path.join(dist, "dist/main.js"), "utf8")
  const bootstrap = runtime.lastIndexOf("bootstrap().catch(")
  assert.ok(bootstrap > 0)
  const program = path.join(root, "native.mjs")
  await fs.symlink(path.join(dist, "node_modules"), path.join(root, "node_modules"))
  await fs.writeFile(program, runtime.slice(0, bootstrap) + `\n{
    const { default: assert } = await import("node:assert/strict");
    const endpoint = ${JSON.stringify({ baseUrl: gateway.baseURL, headers: { authorization: `Bearer ${gateway.key}` } })};
    for (const { model, source } of ${JSON.stringify(jobs)}) {
      for (const [instructions, kind, code, message] of [
        ["calm", "noQuota", "insufficient_quota", "speech budget exhausted"],
        ["missing voice", "rejected", "voice_not_found", "voice_not_found"],
      ]) {
        const submitted = submitOnce({ endpoint, bundle: { source },
          job: { type: "speech", model, prompt: "hello", params: { instructions }, references: {} } });
        await assert.rejects(submitted, { kind, serviceCode: code, status: kind === "noQuota" ? 429 : 400, message: new RegExp(message) });
      }
    }
    process.exit(0);
  }`)
  let ready = false
  for (let n = 0; n < 100 && !ready; n++) {
    if (daemon.exitCode !== null) throw new Error(`Sandbox gateway exited with ${daemon.exitCode}`)
    try { ready = (await fetch(`${gateway.baseURL}/models`, { signal: AbortSignal.timeout(1000) })).ok }
    catch (err) { if (err.cause?.code !== "ECONNREFUSED" && err.name !== "TimeoutError") throw err }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, "sandbox gateway started")
  await promisify(execFile)(path.join(app, "Contents/MacOS/MiniMax Design"), [program], { cwd: root,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", HILO_RELEASE_REGION: "domestic", HILO_RELEASE_CHANNEL: "prod" }, timeout: 30000 })
  assert.deepEqual(sent.map(req => req.model).sort(), [...ids, ...ids].sort())
  assert.ok(sent.some(req => req.instructions === "calm") && sent.some(req => req.instructions === "missing voice"))
  console.log("PASS: Qwen3 and MiMo HTTP 200 speech errors reach Design with the provider message, code and noQuota category")
} finally {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = once(daemon, "exit")
    daemon.kill()
    await stopped
  }
  await new Promise(resolve => upstream.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
}
