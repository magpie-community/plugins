import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import * as adapter from "./media.adapter.js"
import { applyMedia, connection, discoverMedia, mediaPaths, syncMedia } from "./media-sync.mjs"

const gateway = { baseURL: "http://127.0.0.1:3425/v1", key: "magpie-minimax-design" }
const catalogue = [
  { ref: "vendor/draw", type: "image", name: "Draw", images: true },
  { ref: "vendor/film", type: "video", name: "Film", images: true },
]

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-media-"))
  const paths = mediaPaths(home, "darwin")
  fs.mkdirSync(path.dirname(paths.control), { recursive: true })
  fs.writeFileSync(paths.control, JSON.stringify({ config: { customModels: {
    "user-custom-magpie": { magpieAgent: "minimax-design", baseUrl: gateway.baseURL, apiKey: gateway.key },
  } } }))
  return { home, paths, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test("native adapters use images and authenticated video polling", () => {
  const image = adapter.buildSubmit({ type: "image", model: "vendor/draw", prompt: "hello", params: { size: "1:1" },
    images: [{ dataUrl: "data:image/png;base64,AA==" }] })
  assert.equal(image.path, "/images/edits")
  assert.deepEqual(image.body.images, [{ image_url: "data:image/png;base64,AA==" }])
  assert.equal(adapter.parseSubmit({ body: { data: [{ b64_json: "AA==" }] } }, image).outputs[0].base64, "AA==")
  const video = adapter.buildSubmit({ type: "video", model: "vendor/film", prompt: "hello", params: { seconds: 6 },
    images: [{ dataUrl: "data:image/png;base64,AA==" }] })
  assert.equal(video.path, "/videos")
  assert.equal(video.body.seconds, "6")
  const submitted = adapter.parseSubmit({ body: { id: "video-task" } }, { ...video, type: "video" })
  assert.equal(submitted.taskId, "video-task")
  submitted.id = submitted.taskId
  assert.equal(adapter.parsePoll({ body: { status: "in_progress", progress: 50 } }, submitted).progress, 0.5)
  const done = adapter.parsePoll({ body: { status: "completed" } }, submitted)
  assert.equal(done.outputs[0].fetch.path, "/videos/video-task/content")
  assert.equal(done.outputs[0].fetch.response, undefined)
  assert.equal(adapter.parsePoll({ body: { status: "failed" } }, submitted).status, "failed")
})

test("generated protocol providers use the configured Magpie gateway with its assigned key", (t) => {
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  const write = (customModels) => fs.writeFileSync(paths.control, JSON.stringify({ config: { customModels } }))
  const managed = { magpieAgent: "minimax-design", providerName: "Magpie", baseUrl: "https://gateway.example/v1", apiKey: "fixture-key" }
  write({ "user-custom-magpie-anthropic": managed })
  assert.deepEqual(connection(paths), { baseURL: managed.baseUrl, key: managed.apiKey })
  write({ "user-custom-magpie": managed, "user-custom-magpie-anthropic": { ...managed, baseUrl: "https://different.example/v1" } })
  assert.throws(() => connection(paths), /disagree/)
  write({ "user-custom-magpie": { providerName: "Magpie", baseUrl: "https://restored.example/v1", apiKey: "user-key" } })
  assert.equal(connection(paths), null)
  const legacy = { providerName: "Magpie", baseUrl: managed.baseUrl, apiKey: managed.apiKey }
  paths.stash = path.join(path.dirname(paths.control), "test-stash.json")
  fs.writeFileSync(paths.stash, JSON.stringify({ [`plugin:minimax-design:${paths.agentControl}`]: JSON.stringify({
    had: { "config.customModels.user-custom-magpie-anthropic": "\u0000" }, value: managed.apiKey,
  }) }))
  write({ "user-custom-magpie-anthropic": legacy, "user-custom-magpie": { ...legacy, baseUrl: "https://mine.example/v1" } })
  assert.deepEqual(connection(paths), { baseURL: managed.baseUrl, key: managed.apiKey })
  fs.writeFileSync(paths.stash, "{}")
  assert.equal(connection(paths), null)
  write({ "user-custom-sibling": managed })
  assert.equal(connection(paths), null)
})

test("multi-hop media discovery uses source metadata and preserves the routed model ID", async (t) => {
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  const local = "image-models/rightimage/gemini-nano-banana-2.1"
  const routed = `studio-mini/remote-magpie/${local}`
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ data: [
    { id: routed, owned_by: "studio-mini", magpie_via: ["source", "relay", "local"], kind: "image",
      modalities: { input: ["image"] } },
  ] }) }))
  const providers = { "image-models/rightimage": { models: { "gemini-nano-banana-2.1": {
    supported_parameters: {
      aspect_ratio: { type: "enum", values: ["16:9"] },
      resolution: { type: "enum", values: ["2K"] },
    },
    capabilities: { maxReferences: 14 },
    media_request: { size: "aspect-resolution" },
  } } } }
  const catalogue = await discoverMedia(gateway, {}, providers)
  assert.equal(catalogue[0].route, local)
  assert.equal(catalogue[0].ref, routed)
  applyMedia(paths, gateway, catalogue)
  const config = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
  const [model] = config.models
  const folder = path.join(paths.store, "models", model.id)
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "spec.json"))).references.image.max, 14)
  const generated = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(folder, "adapter.js")).toString("base64")}`)
  const request = generated.buildSubmit({ type: "image", model: model.upstreamModel, prompt: "edit", images: [],
    params: { aspect_ratio: "16:9", resolution: "2K" } })
  assert.equal(request.body.model, routed)
  assert.equal(request.body.size, "16:9@2K")
})

test("source plugin GPT presets keep the remote ID and external H3 stays on its declared transport", async (t) => {
  const remote = "remote-magpie/image-models/rightimage/gpt-image-2.6-flare"
  const legacyRelay = "studio/office/old/image-models/rightimage/gpt-image-2.6-flare"
  const local = "rightimage/gpt-image-2.6-flare"
  const external = "external/minimax/MiniMax-H3"
  const providers = {
    "image-models/rightimage": { models: { "gpt-image-2.6-flare": {} } },
    external: { models: { "minimax/MiniMax-H3": { media_request: { video: "ark" } } } },
  }
  const data = [
    { id: remote, kind: "image" },
    { id: legacyRelay, owned_by: "studio", magpie_via: ["office", "studio"], kind: "image" },
    { id: local, kind: "image" },
    { id: external, owned_by: "external", magpie_via: ["local"], kind: "video" },
  ]
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }))
  const models = await discoverMedia(gateway, {}, providers)
  const source = remote.slice("remote-magpie/".length)
  assert.deepEqual(models.map((model) => model.route), [source, source, local, external])
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  applyMedia(paths, gateway, models)
  const config = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
  assert.equal(config.models.length, data.length)
  for (const entry of config.models) {
    const spec = JSON.parse(fs.readFileSync(path.join(paths.store, "models", entry.id, "spec.json")))
    if (entry.type === "video") assert.equal(spec.params.find(param => param.key === "aspect_ratio"), undefined)
    else assert.ok(spec.params.some(param => param.key === "resolution"))
    const generated = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(paths.store, "models", entry.id, "adapter.js")).toString("base64")}`)
    if (entry.type === "image") {
      const { body } = generated.buildSubmit({ type: entry.type, model: entry.upstreamModel, prompt: "hello", params: { aspect_ratio: "16:9", resolution: "2K" }, images: [] })
      assert.equal(body.size, "2048x1152")
      assert.equal(body.model, entry.upstreamModel)
      const refusal = generated.parseError({ status: 200, body: { error: { message: "balance", code: 1008 } } })
      assert.equal(refusal.kind, "rejected")
    } else {
      assert.equal(generated.parseError({ status: 200, body: { error: { message: "balance", code: 1008 } } }).kind, "rejected")
    }
  }
})

test("incomplete relay history still identifies known H3, speech and declared source routes", async (t) => {
  const routes = ["minimax-code/MiniMax-H3", "mlx-audio-tools/mlx-community/Ming-3.0-tts-0.5B-8bit", "vendor/nested/image"]
  const histories = [["office"], ["studio", "office"], []]
  const data = histories.flatMap((relays) => routes.map((route, i) => ({
    id: [...relays, route].join("/"), owned_by: relays[0], magpie_via: relays.map((_, n) => `node-${n}`),
    kind: ["video", "model", "image"][i],
  })))
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }))
  const options = { mediaParameters: {}, mediaRequests: {} }
  for (const { id, kind } of data) {
    if (kind === "video") options.mediaParameters[id] = { seconds: { type: "enum", values: [6] } }
    if (kind === "model") options.mediaParameters[id] = { instructions: { type: "string", default: "calm" } }
    if (kind === "image") options.mediaRequests[id] = { outputs_per_task: 3 }
  }
  const models = await discoverMedia(gateway, options, { vendor: { models: { "nested/image": {} } } })
  assert.deepEqual(models.map((model) => model.route), [...routes, ...routes, ...routes])
  assert.deepEqual(models.map((model) => model.ref), data.map((model) => model.id))
  const { mediaCapability } = await import("./media-capabilities.mjs")
  for (const start of [0, 3, 6]) {
    assert.equal(mediaCapability(models[start]).transport, "minimax-video")
    assert.equal(mediaCapability(models[start + 1]).ming, true)
    assert.equal(mediaCapability(models[start + 2]).outputsPerTask, 3)
    assert.deepEqual(mediaCapability(models[start]).params.find(p => p.key === "duration").enum, ["6"])
  }
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  applyMedia(paths, gateway, models)
  for (const entry of JSON.parse(fs.readFileSync(path.join(paths.store, "config.json"))).models) {
    const file = path.join(paths.store, "models", entry.id, "adapter.js")
    const generated = await import(`data:text/javascript;base64,${fs.readFileSync(file).toString("base64")}`)
    const params = entry.type === "video" ? { duration: "6" } : {}
    const { body } = generated.buildSubmit({ type: entry.type, model: entry.upstreamModel, prompt: "hello", params, images: [] })
    assert.ok(data.some(({ id }) => id === body.model))
    if (entry.type === "video") assert.equal(body.seconds, "6")
    if (entry.type === "speech") assert.equal(body.instructions, "calm")
    if (entry.type === "image") assert.equal(body.n, 3)
  }
})

test("one-hop relay options preserve source metadata without via history", async (t) => {
  const id = "office/vendor/nested/image"
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id, owned_by: "office", kind: "image" }] }))
  const options = { mediaRequests: { [id]: { outputs_per_task: 3 } } }
  const providers = { vendor: { models: { "nested/image": { media_request: { size: "aspect-resolution" },
    supported_parameters: { aspect_ratio: { type: "enum", values: ["16:9"] }, resolution: { type: "enum", values: ["2K"] } } } } } }
  const [model] = await discoverMedia(gateway, options, providers)
  assert.equal(model.route, "vendor/nested/image")
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  applyMedia(paths, gateway, [model])
  const [entry] = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json"))).models
  const file = path.join(paths.store, "models", entry.id, "adapter.js")
  const generated = await import(`data:text/javascript;base64,${fs.readFileSync(file).toString("base64")}`)
  const { body } = generated.buildSubmit({ type: "image", model: entry.upstreamModel, prompt: "hello", images: [],
    params: { aspect_ratio: "16:9", resolution: "2K" } })
  assert.deepEqual([body.model, body.size, body.n], [id, "16:9@2K", 3])
})

test("partial gateway request mappings preserve source batch size", async (t) => {
  const data = [{ id: "studio/image", kind: "image", media_request: { size: "pixels" } }]
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }))
  const [model] = await discoverMedia(gateway, { mediaRequests: { "studio/image": { outputs_per_task: 1 } } }, { studio: { models: {
    image: { media_request: { outputs_per_task: 3, size: "aspect-resolution" } },
  } } })
  assert.deepEqual(model.mediaRequest, { outputs_per_task: 3, size: "pixels" })
  const { paths, cleanup } = sandbox()
  t.after(cleanup)
  applyMedia(paths, gateway, [model])
  const [entry] = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json"))).models
  assert.equal(entry.outputsPerTask, 3)
  const file = path.join(paths.store, "models", entry.id, "adapter.js")
  const generated = await import(`data:text/javascript;base64,${fs.readFileSync(file).toString("base64")}`)
  assert.equal(generated.buildSubmit({ type: "image", model: model.ref, prompt: "", params: {}, images: [] }).body.n, 3)
})

test("HTTP 200 submit refusals preserve the provider code and quota category", () => {
  for (const type of ["image", "video", "speech"]) {
    assert.deepEqual(adapter.parseSubmit({ status: 200, body: { error: { message: "quota", code: 2068 } } }, { type }),
      { error: "quota", code: "2068", kind: "noQuota" })
  }
})

test("media errors retain provider codes and distinguish quota, credentials and retry", () => {
  for (const [status, body, kind, code] of [
    [429, { error: { message: "quota", type: "insufficient_quota" } }, "noQuota", "insufficient_quota"],
    [503, { error: { message: "busy" } }, "retry", undefined],
    [429, { error: { message: "rate", code: "rate_limit_exceeded" } }, "retry", "rate_limit_exceeded"],
    [401, { error: { message: "unauthorized" } }, "unauthorized", undefined],
    [400, { detail: { message: "invalid", code: 4001 } }, "rejected", "4001"],
  ]) {
    const result = adapter.parseError({ status, body })
    assert.equal(result.kind, kind)
    assert.equal(result.code, code)
    assert.equal(result.message, body.error?.message ?? body.detail.message)
  }
  assert.deepEqual(adapter.parsePoll({ body: { status: "failed", error: { code: "task_failed", message: "Failed" } } }, {}),
    { status: "failed", message: "Failed", code: "task_failed" })
})

test("incremental sync preserves user models, enabled state and timestamps", () => {
  const { paths, cleanup } = sandbox()
  try {
    applyMedia(paths, gateway, catalogue)
    const initial = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    const first = initial.models.find((entry) => entry.type === "image")
    const created = first.createdAt
    applyMedia(paths, gateway, catalogue.map((entry) => ({ ...entry, name: entry.name + " updated" })))
    const updated = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    assert.equal(updated.models.find((entry) => entry.id === first.id).enabled, true)
    assert.equal(updated.models.find((entry) => entry.id === first.id).createdAt, created)
    const store = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    store.models = [{ id: "custom-000000000000000000000000", name: "User", type: "image", provider: "provider-user",
      upstreamModel: "user/model", enabled: false, spec: { kind: "own" }, adapter: { kind: "own" }, createdAt: 1, updatedAt: 1 }, ...store.models]
    store.providers.push({ id: "provider-user", name: "User" })
    store.models.find((entry) => entry.id === first.id).enabled = false
    fs.writeFileSync(path.join(paths.store, "config.json"), JSON.stringify(store))
    applyMedia(paths, gateway, [catalogue[0]])
    const shrunk = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    assert.equal(shrunk.models.find((entry) => entry.id === first.id).enabled, false)
    assert.equal(shrunk.models.find((entry) => entry.name === "User").enabled, false)
    assert.equal(shrunk.providers.find((entry) => entry.id === "provider-user").name, "User")
    fs.writeFileSync(paths.control, JSON.stringify({}))
    applyMedia(paths, null, [])
    const removed = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    assert.equal(removed.models.length, 1)
    assert.equal(removed.providers.length, 1)
  } finally { cleanup() }
})

test("busy store fails without changing files; discovery failure preserves the catalogue", async () => {
  const { paths, cleanup } = sandbox()
  try {
    applyMedia(paths, gateway, catalogue)
    const before = fs.readFileSync(path.join(paths.store, "config.json"), "utf8")
    fs.mkdirSync(path.join(paths.store, "config.json.lock"))
    assert.throws(() => applyMedia(paths, gateway, []), { code: "EEXIST" })
    fs.rmdirSync(path.join(paths.store, "config.json.lock"))
    assert.equal(fs.readFileSync(path.join(paths.store, "config.json"), "utf8"), before)
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("offline") }
    try { await assert.rejects(syncMedia(paths), /offline/) }
    finally { globalThis.fetch = original }
    assert.equal(fs.readFileSync(path.join(paths.store, "config.json"), "utf8"), before)
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
      { id: "vendor/draw", kind: "image", display_name: "Draw", modalities: { input: ["text", "image"] } },
      { id: "vendor/draw", kind: "image" }, { id: "vendor/text", kind: "text" },
    ] }) })
    try {
      assert.equal((await discoverMedia(gateway)).length, 1)
      const result = await syncMedia(paths)
      assert.equal(result.models, 1)
    } finally { globalThis.fetch = original }
    assert.equal(connection(paths).key, gateway.key)
  } finally { cleanup() }
})

test("unsupported stores and provider limits fail without truncation", () => {
  const { paths, cleanup } = sandbox()
  try {
    fs.mkdirSync(paths.store, { recursive: true })
    fs.writeFileSync(path.join(paths.store, "config.json"), JSON.stringify({ version: 2 }))
    assert.throws(() => applyMedia(paths, gateway, catalogue), /Unsupported/)
    fs.writeFileSync(path.join(paths.store, "config.json"), JSON.stringify({ version: 1, providers: [], models: [] }))
    assert.throws(() => applyMedia(paths, gateway, Array.from({ length: 201 }, (_, index) =>
      ({ ref: `vendor/${index}`, type: "image", name: `Image ${index}` }))), /limit would be exceeded/)
    fs.writeFileSync(path.join(paths.store, "config.json"), JSON.stringify({ version: 1, providers: [], models: [] }))
    assert.doesNotThrow(() => applyMedia(paths, gateway, catalogue))
  } finally { cleanup() }
})

test("invalid catalogue IDs are rejected at discovery", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "bad\u0000id", kind: "image" }] }) })
  try { await assert.rejects(discoverMedia(gateway), /invalid model ID/) }
  finally { globalThis.fetch = original }
})

test("an unmanaged model directory is never overwritten", () => {
  const { paths, cleanup } = sandbox()
  try {
    applyMedia(paths, gateway, catalogue)
    const store = JSON.parse(fs.readFileSync(path.join(paths.store, "config.json")))
    const folder = path.join(paths.store, "models", store.models[0].id)
    const before = fs.readFileSync(path.join(folder, "adapter.js"), "utf8")
    fs.rmSync(paths.state)
    fs.writeFileSync(path.join(paths.store, "config.json"), JSON.stringify({ version: 1, providers: [], models: [] }))
    assert.throws(() => applyMedia(paths, gateway, catalogue), /unmanaged media model directory/)
    assert.equal(fs.readFileSync(path.join(folder, "adapter.js"), "utf8"), before)
  } finally { cleanup() }
})

test("explicit source routes preserve existing Design IDs and switches without duplicate models", async () => {
  const { paths, cleanup } = sandbox()
  const original = globalThis.fetch
  const legacy = "existing-provider/old-model"
  const replacement = "other-provider/new-model"
  const options = { imageRoutes: { [legacy]: replacement },
    mediaParameters: { [replacement]: { input_references: { type: "range", min: 0, max: 4 } } } }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: legacy, kind: "image", display_name: "General Image 2.1", modalities: { input: ["text"] } },
    { id: replacement, kind: "image", modalities: { input: ["text", "image"] } },
  ] }) })
  try {
    assert.equal((await discoverMedia(gateway)).length, 2)
    applyMedia(paths, gateway, [{ ref: legacy, name: "General Image 2.1", type: "image", images: false }])
    const config = path.join(paths.store, "config.json")
    const previous = JSON.parse(fs.readFileSync(config))
    previous.models[0].enabled = false
    fs.writeFileSync(config, JSON.stringify(previous))
    const models = await discoverMedia(gateway, options)
    assert.equal(models.length, 1)
    assert.equal(models[0].requestModel, replacement)
    applyMedia(paths, gateway, models)
    const updated = JSON.parse(fs.readFileSync(config))
    assert.equal(updated.models[0].id, previous.models[0].id)
    assert.equal(updated.models[0].enabled, false)
    assert.equal(updated.models[0].name, "General Image 2.1")
    const folder = path.join(paths.store, "models", updated.models[0].id)
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "spec.json"))).references.image.max, 4)
    assert.ok(fs.readFileSync(path.join(folder, "adapter.js"), "utf8").includes(replacement))
    await assert.rejects(discoverMedia(gateway, { imageRoutes: { [legacy]: "missing/model" } }), /unavailable/)
    await assert.rejects(discoverMedia(gateway, { imageRoutes: [] }), /imageRoutes/)
    await assert.rejects(discoverMedia(gateway, { imageRoutes: { [legacy]: replacement, [replacement]: "another/model" } }), /imageRoutes/)
    await assert.rejects(discoverMedia(gateway, { mediaParameters: [] }), /mediaParameters/)
  } finally { globalThis.fetch = original; cleanup() }
})

test("new models use edit endpoints and explicit reference schemas before manual supplements", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: "new-source/未来 image Pro", kind: "image", supported_endpoint_types: ["image-edit"],
      supported_parameters: { input_references: { type: "range", min: 0, max: 6 } } },
    { id: "new-source/future-video", kind: "video",
      supported_parameters: { input_references: { type: "range", min: 0, max: 1 } } },
  ] }) })
  try {
    const models = await discoverMedia(gateway, { mediaParameters: {
      "new-source/未来 image Pro": { input_references: { type: "range", min: 0, max: 4 } },
    } })
    assert.equal(models[0].images, true)
    assert.equal(models[0].ref, "new-source/未来 image Pro")
    assert.equal(models[0].parameters.input_references.max, 6)
    const { mediaCapability } = await import("./media-capabilities.mjs")
    assert.equal(mediaCapability(models[1]).references.max, 1)
  } finally { globalThis.fetch = original }
})

test("shared provider capabilities fill catalogue gaps without overriding explicit gateway limits", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: "other/provider/new-image", kind: "image", modalities: { input: ["text"] } },
    { id: "other/provider/disabled", kind: "image",
      supported_parameters: { input_references: { type: "range", min: 0, max: 0 } } },
    { id: "other/provider/video", kind: "video", modalities: { input: ["text"] } },
  ] }) })
  const providers = { "other/provider": { models: {
    "new-image": { modalities: { input: ["text", "image"] }, capabilities: { edit: true, maxReferences: 6 } },
    disabled: { capabilities: { edit: true, maxReferences: 8 } },
    video: { capabilities: { maxReferences: 1 } },
    hidden: { capabilities: { edit: true, maxReferences: 8 } },
  } } }
  try {
    const models = await discoverMedia({ ...gateway, baseURL: "https://another-gateway.example/v1" }, {
      mediaParameters: { "other/provider/disabled": { input_references: { type: "range", min: 0, max: 9 } } },
    }, providers)
    assert.equal(models.length, 3)
    assert.equal(models[0].images, true)
    assert.equal(models[0].parameters.input_references.max, 6)
    assert.equal(models[0].parameterSource, "plugin-config")
    assert.equal(models[1].parameters.input_references.max, 0)
    const { mediaCapability } = await import("./media-capabilities.mjs")
    assert.equal(mediaCapability(models[2]).references.max, 1)
  } finally { globalThis.fetch = original }
})

test("discovery retains native constraints while gateway declarations take precedence", async () => {
  const original = globalThis.fetch
  const parameter_config = { dimensions: [{ key: "resolution", default_value: "2K" }] }
  globalThis.fetch = async () => Response.json({ data: [
    { id: "portable/image", kind: "image", capabilities: { total_limit: 4 } },
  ] })
  try {
    const [model] = await discoverMedia(gateway, {}, { portable: { models: {
      image: { capabilities: { total_limit: 9, parameter_config } },
    } } })
    assert.equal(model.sourceCapabilities.total_limit, 4)
    assert.deepEqual(model.sourceCapabilities.parameter_config, parameter_config)
  } finally { globalThis.fetch = original }
})
