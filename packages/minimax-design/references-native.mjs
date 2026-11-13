import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import { mediaPaths } from "./media-sync.mjs"

const binary = process.env.MAGPIE_BIN
if (!binary) throw new Error("Set MAGPIE_BIN for native gateway reference validation.")
const sourcePlugin = process.env.IMAGE_MODELS_PLUGIN
if (!sourcePlugin) throw new Error("Set IMAGE_MODELS_PLUGIN for the tested image source plugin.")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-reference-gateway-"))
const paths = mediaPaths(root, "darwin")
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
const referenceBytes = Array.from({ length: 4 }, (_, index) => Buffer.concat([png, Buffer.from([index])]))
const calls = []
const failures = []
const fixture = http.createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    response.setHeader("content-type", "application/json")
    if (request.method === "GET") {
      if (request.url === "/v1/tasks/gpt") {
        response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${fixture.address().port}/image.png` }] }))
        return
      }
      if (request.url === "/v1/tasks/gemini") {
        response.end(JSON.stringify({ candidates: [{ content: { parts: [
          { text: `http://127.0.0.1:${fixture.address().port}/image.png` },
        ] } }] }))
        return
      }
      if (request.url === "/image.png") {
        assert.equal(request.headers.authorization, undefined)
        response.setHeader("content-type", "image/png")
        response.end(png)
        return
      }
      response.end(JSON.stringify({ data: [{ id: "gemini-nano-banana-2.1" }, { id: "gpt-image-2.6-flare" }] }))
      return
    }
    if (request.url === "/v1/images/edits") {
      const body = JSON.parse(bytes)
      assert.equal(body.model, "future-openai-image")
      assert.equal(body.async, true)
      assert.deepEqual(body.images, referenceBytes.map((bytes) => `data:image/png;base64,${bytes.toString("base64")}`))
      response.end(JSON.stringify({ task_id: "gpt" }))
    } else if (request.url === "/v1beta/models/future-native-image:generateContent") {
      const body = JSON.parse(bytes)
      const parts = body.contents[0].parts
      assert.equal(parts.length, 5)
      for (const [index, part] of parts.slice(1).entries()) {
        assert.equal(part.inline_data.mime_type, "image/png")
        assert.deepEqual(Buffer.from(part.inline_data.data, "base64"), referenceBytes[index])
      }
      assert.equal(body.async, true)
      response.end(JSON.stringify({ task_id: "gemini" }))
    } else throw new Error(`Unexpected upstream route: ${request.url}`)
    calls.push(request.url)
  } catch (error) {
    console.error(error.message)
    failures.push(error)
    response.writeHead(500).end(JSON.stringify({ error: { message: error.message } }))
  }
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const config = path.join(root, ".config/magpie")
fs.mkdirSync(config, { recursive: true })
const upstream = `http://127.0.0.1:${fixture.address().port}`
fs.writeFileSync(path.join(config, "providers.json"), JSON.stringify({ providers: [{
  id: "rightimage", name: "Reference fixture", key: "fixture-only", chat: `${upstream}/v1`,
  gemini: `${upstream}/v1beta`, baseAPI: "chat", models: ["gemini-nano-banana-2.1", "gpt-image-2.6-flare"],
}] }))
fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({
  modelAPIs: { "rightimage/gemini-nano-banana-2.1": "gemini" },
  modelImages: { "rightimage/gemini-nano-banana-2.1": true },
}))
fs.writeFileSync(path.join(config, "plugins.json"), JSON.stringify({ plugins: [{
  spec: new URL(".", import.meta.url).pathname, options: { imageRoutes: {
    "rightimage/gemini-nano-banana-2.1": "image-models/rightimage/future-native-image",
    "rightimage/gpt-image-2.6-flare": "image-models/rightimage/future-openai-image",
  } },
}, {
  spec: sourcePlugin, options: { onlyProvider: "image-models/rightimage", baseURL: `${upstream}/v1`,
    models: {
      "future-native-image": { name: "Future native", mode: "gemini",
        capabilities: { generate: true, edit: true, maxReferences: 6 } },
      "future-openai-image": { name: "Future standard", mode: "openai",
        capabilities: { generate: true, edit: true, maxReferences: 6 } },
    } },
}] }))
fs.mkdirSync(path.dirname(paths.control), { recursive: true })
fs.writeFileSync(paths.control, JSON.stringify({ config: { customModels: {
  "user-custom-magpie": { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "magpie-minimax-design" },
} } }))
fs.writeFileSync(path.join(config, "plugin-auth.json"), JSON.stringify({
  "image-models/rightimage": { type: "api", key: "fixture-only" },
}))
const log = fs.openSync(path.join(root, "gateway.log"), "w")
const processHandle = spawn(binary, ["serve"], {
  env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"),
    MAGPIE_BUN: process.env.MAGPIE_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
    MAGPIE_ADDR: `127.0.0.1:${port}`, NO_PROXY: "localhost,127.0.0.1,::1" },
  stdio: ["ignore", log, log],
})
const gateway = { baseURL: `http://127.0.0.1:${port}/v1`, key: "magpie-minimax-design" }
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`Gateway exited; see ${root}/gateway.log`)
    try {
      const response = await fetch(`${gateway.baseURL}/models`, {
        headers: { "X-Magpie-Drawers": "1" }, signal: AbortSignal.timeout(1000),
      })
      if (response.ok && (await response.json()).data.some((model) =>
        model.id === "image-models/rightimage/gemini-nano-banana-2.1")) { ready = true; break }
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED" && error.name !== "TimeoutError") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Gateway not ready; see ${root}/gateway.log`)
  let store
  for (let attempt = 0; attempt < 100; attempt++) {
    const file = path.join(paths.store, "config.json")
    if (fs.existsSync(file)) {
      store = JSON.parse(fs.readFileSync(file))
      const model = store.models.find((entry) => entry.upstreamModel === "rightimage/gemini-nano-banana-2.1")
      if (model && JSON.parse(fs.readFileSync(path.join(paths.store, "models", model.id, "spec.json"))).references.image?.max === 6) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const migrated = store?.models.filter((model) => model.upstreamModel.startsWith("rightimage/"))
  assert.equal(migrated?.length, 2, `Shared plugin config was not synchronized; see ${root}/gateway.log`)
  for (const model of migrated) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.store, "models", model.id, "spec.json"))).references.image.max, 6)
    const adapter = await import(`file://${paths.store}/models/${model.id}/adapter.js`)
    const request = { type: "image", model: model.upstreamModel, prompt: "reference fixture", params: {},
      images: referenceBytes.map((bytes) => ({
        mime: "image/png", base64: bytes.toString("base64"), dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      })) }
    const call = adapter.buildSubmit(request)
    const response = await fetch(call.path.startsWith("http") ? call.path : `${gateway.baseURL}${call.path}`, {
      method: call.method, headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
      body: JSON.stringify(call.body), signal: AbortSignal.timeout(20000),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(adapter.parseSubmit({ body }, request).outputs.length, 1)
  }
  assert.deepEqual(failures, [])
  assert.equal(calls.length, 2)
  console.log("PASS: persisted plugin options and shared source capabilities synchronize automatically")
  console.log("PASS: real Magpie forwards four exact images through renamed models using both source protocols")
  console.log(`Fixture evidence: ${root}`)
} finally {
  const exited = once(processHandle, "exit")
  processHandle.kill("SIGTERM")
  await exited
  fs.closeSync(log)
  await new Promise((resolve) => fixture.close(resolve))
}
