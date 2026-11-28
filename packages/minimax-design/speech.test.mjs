import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { mediaCapability, mediaSpec } from "./media-capabilities.mjs"
import { discoverMedia } from "./media-sync.mjs"
import { speechModel } from "./speech.mjs"

const source = fs.readFileSync(new URL("./media.adapter.js", import.meta.url), "utf8")
const ming = { ref: "mlx-audio-tools/mlx-community/Ming-3.0-tts-0.5B-8bit", type: "speech", owner: "mlx-audio-tools" }

async function configured(model = ming) {
  const capability = mediaCapability(model)
  const generated = source.replace("const capability = null", () => `const capability = ${JSON.stringify(capability)}`)
  const adapter = await import(`data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`)
  return { capability, adapter, submit: (params = {}, extra = {}) => adapter.buildSubmit({
    type: "speech", model: model.ref, prompt: "测试配音", params, images: [], ...extra,
  }) }
}

test("speech discovery requires a verified speech route and excludes ASR, chat audio and music", async () => {
  assert.equal(speechModel({ id: ming.ref }), true)
  assert.equal(speechModel({ id: `remote-magpie/${ming.ref}`, owned_by: "remote-magpie" }), true)
  assert.equal(speechModel({ id: `alias/${ming.ref}`, owned_by: "alias" }), false)
  for (const id of ["vendor/tts", "vendor/whisper", "openrouter/google/lyria-3-pro-preview"]) {
    assert.equal(speechModel({ id, modalities: { output: ["audio"] } }), false)
  }
  assert.equal(speechModel({ id: "new/voice", native_endpoints: ["/v1/audio/speech"] }), true)
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: ming.ref, owned_by: ming.owner, supported_parameters: ["tools"] },
    { id: "new/voice", native_endpoints: ["/v1/audio/speech"], supported_parameters: { voice: { type: "enum", values: ["new"] } } },
    { id: "vendor/asr", native_endpoints: ["/v1/audio/transcriptions"] },
    { id: "openrouter/google/lyria-3-pro-preview", modalities: { output: ["audio"] } },
  ] }) })
  try {
    const models = await discoverMedia({ baseURL: "http://fixture/v1", key: "fixture" })
    assert.deepEqual(models.map((model) => model.type), ["speech", "speech"])
    assert.equal(mediaCapability(models[1]).defaults.voice, "new")
  } finally { globalThis.fetch = original }
})

test("Ming automatically sends defaults and validates voice, instructions, formats and references", async () => {
  const { submit, capability } = await configured()
  assert.deepEqual(mediaSpec(capability).references, {})
  assert.deepEqual(submit(), { method: "POST", path: "/audio/speech", response: "binary",
    body: { model: ming.ref, input: "测试配音", voice: "default", response_format: "wav" } })
  assert.equal(submit({ speed: 1.25, response_format: "mp3" }).body.speed, 1.25)
  assert.equal(submit({ instructions: "低沉男声" }).body.instructions, "低沉男声")
  assert.throws(() => submit({ voice: "US_Alice", instructions: "低沉男声" }), /只能选择一项/)
  assert.throws(() => submit({ voice: "   " }), /不能为空/)
  assert.throws(() => submit({ voice: "arbitrary-voice" }), /格式不正确/)
  assert.throws(() => submit({ speed: NaN }), /不支持参数/)
  assert.throws(() => submit({ speed: "1.25" }), /不支持参数/)
  assert.throws(() => submit({ response_format: "pcm" }), /不支持参数/)
  assert.throws(() => submit({}, { audios: [{}] }), /不接受参考/)
})

test("explicit speech metadata supplies automatic voice and valid defaults without unverified controls", async () => {
  const model = { ref: "vendor/new-speech", type: "speech", parameters: {
    voice: { type: "enum", values: ["a", "b"], default: "b" },
    response_format: { type: "enum", values: ["wav"] },
    speed: { type: "range", min: 0.8, max: 1.2, default: 1 },
  } }
  const { submit } = await configured(model)
  assert.deepEqual(submit().body, { model: model.ref, input: "测试配音", voice: "b", response_format: "wav", speed: 1 })
  assert.throws(() => submit({ voice: "c" }), /不支持参数/)
  assert.throws(() => submit({ speed: 1.5 }), /不支持参数/)
  assert.throws(() => submit({ instructions: "warm" }), /不支持参数/)
  assert.throws(() => mediaCapability({ ...model, parameters: { response_format: { type: "enum", values: ["pcm"] } } }), /playable/)
  assert.throws(() => mediaCapability({ ...model, parameters: { voice: { type: "enum", values: ["a"], default: "b" } } }), /default/)
  assert.throws(() => mediaCapability({ ...model, parameters: { speed: { type: "range", min: 1, max: 0.5 } } }), /schema/)
  const generic = await configured({ ref: "vendor/speech", type: "speech" })
  assert.throws(() => generic.submit(), /请填写音色/)
  assert.equal(generic.submit({ voice: "provided" }).body.voice, "provided")
})

test("speech accepts binary audio and refuses JSON errors, empty and non-audio success bodies", async () => {
  const { adapter } = await configured()
  const request = { type: "speech" }
  assert.deepEqual(adapter.parseSubmit({ headers: { "content-type": "audio/wav" },
    body: { $binary: true, size: 200 } }, request), { outputs: [{ responseBody: true }] })
  for (const response of [
    { headers: { "content-type": "audio/wav" }, body: { $binary: true, size: 0 } },
    { headers: { "content-type": "application/json" }, body: { $binary: true, size: 200 } },
    { headers: { "content-type": "text/html" }, body: "<html>" },
  ]) assert.match(adapter.parseSubmit(response, request).error, /未返回可播放/)
  assert.equal(adapter.parseSubmit({ body: { error: { message: "no quota" } } }, request).error, "no quota")
})

test("source speech declarations discover renamed models and supply automatic parameters", async () => {
  const original = globalThis.fetch
  const providers = { portable: { models: {
    voice: { native_endpoints: ["/v1/audio/speech"], supported_parameters: {
      voice: { type: "enum", values: ["warm"] },
      response_format: { type: "enum", values: ["wav"] },
    } },
    asr: { native_endpoints: ["/v1/audio/transcriptions"] },
    chat: { modalities: { output: ["audio"] } },
    unavailable: { native_endpoints: ["/v1/audio/speech"] },
  } } }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: "portable/voice", supported_parameters: ["tools"] },
    { id: "portable/asr" }, { id: "portable/chat" },
  ] }) })
  try {
    const models = await discoverMedia({ baseURL: "http://renamed-gateway/v1", key: "fixture" }, {}, providers)
    assert.equal(models.length, 1)
    assert.equal(models[0].ref, "portable/voice")
    assert.equal(models[0].type, "speech")
    const { submit } = await configured(models[0])
    assert.deepEqual(submit().body, {
      model: "portable/voice", input: "测试配音", voice: "warm", response_format: "wav",
    })
  } finally { globalThis.fetch = original }
})

