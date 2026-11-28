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
    "user-custom-magpie": { baseUrl: gateway.baseURL, apiKey: gateway.key },
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
