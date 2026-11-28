import assert from "node:assert/strict"
import { test } from "node:test"
import { VolcengineASRPlugin } from "./index.mjs"

const KEY = "volc-test-key-123"
const TASK = "3f2b6f0e-6c2a-4c55-9a1e-4f1b7f8a9c10"
const ROUTE = "https://openspeech.bytedance.com/magpie/audio/transcriptions"
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])

const FINISHED = {
  audio_info: { duration: 11000 },
  result: {
    text: "And so, my fellow Americans.",
    utterances: [
      { text: "And so,", start_time: 190, end_time: 900, additions: { speaker: "1" } },
      { text: "my fellow Americans.", start_time: 950, end_time: 2500, additions: { speaker: "2" } },
    ],
  },
}

function upstream(answers) {
  const calls = []
  const queue = [...answers]
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined })
    const next = queue.shift()
    if (!next) throw new Error("unexpected upstream call")
    if (next instanceof Error) throw next
    const headers = { "X-Api-Status-Code": next.code, "X-Api-Message": next.message ?? "" }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.http ?? 200, headers })
  }
  return { fetch, calls }
}

async function plugin(answers = [], opts = {}) {
  const auth = "auth" in opts ? opts.auth : { type: "api", key: KEY }
  const up = upstream(answers)
  const hooks = await VolcengineASRPlugin({}, { fetch: up.fetch })
  const loaded = await hooks.auth.loader(async () => auth)
  return { hooks, loaded, up }
}

function form(model, fields, file) {
  const f = new FormData()
  f.set("model", model)
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  if (file) f.set("file", new Blob([file], { type: "audio/wav" }), "clip.wav")
  return f
}

async function call(loaded, model, fields = {}, { file, url = ROUTE, method = "POST" } = {}) {
  const res = await loaded.fetch(url, { method, body: method === "POST" ? form(model, fields, file) : undefined })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, type: res.headers.get("content-type"), text, json }
}

const job = (op, extra = {}) => ({ volc_operation: op, ...extra })
const submit = (extra = {}) =>
  job("submit", { volc_task_id: TASK, audio_url: "https://example.com/a.mp3", audio_format: "mp3", ...extra })

// ---------- shape ----------

test("declares an OpenAI-compatible provider whose config lists its three models", async () => {
  const { hooks } = await plugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["volcengine-asr"]
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(Object.keys(p.models).sort(), ["bigasr-1.0", "bigasr-flash", "seed-asr-2.0"])
  for (const m of Object.values(p.models)) {
    assert.equal(m.modalities.input[0], "audio")
    assert.deepEqual(m.modalities.output, ["text"])
    assert.equal(m.tool_call, false)
  }
  assert.equal(hooks.auth.provider, "volcengine-asr")
  assert.equal(hooks.auth.methods[0].type, "api")
  const listed = await hooks.provider.models({}, { auth: { type: "api", key: KEY } })
  assert.deepEqual(Object.keys(listed).sort(), ["bigasr-1.0", "bigasr-flash", "seed-asr-2.0"])
})

test("loader gives nothing without a signed-in key", async () => {
  assert.deepEqual((await plugin([], { auth: undefined })).loaded, {})
  assert.deepEqual((await plugin([], { auth: { type: "api", key: "" } })).loaded, {})
})

test("only POST to the transcription route is served", async () => {
  const { loaded, up } = await plugin()
  const chat = await call(loaded, "seed-asr-2.0", submit(), { url: "https://openspeech.bytedance.com/magpie/chat/completions" })
  assert.equal(chat.status, 404)
  assert.equal((await call(loaded, "seed-asr-2.0", {}, { method: "GET" })).status, 404)
  assert.equal(up.calls.length, 0)
})

test("an unknown model is refused", async () => {
  const { loaded, up } = await plugin()
  const out = await call(loaded, "whisper-1", {}, { file: AUDIO })
  assert.equal(out.status, 404)
  assert.equal(up.calls.length, 0)
})

// ---------- flash: a standard OpenAI upload ----------

test("an uploaded file goes to the flash API as base64 and answers OpenAI json", async () => {
  const { loaded, up } = await plugin([{ code: "20000000", body: FINISHED }])
  const out = await call(loaded, "bigasr-flash", {}, { file: AUDIO })
  assert.equal(out.status, 200)
  assert.deepEqual(out.json, { text: "And so, my fellow Americans." })
  const [c] = up.calls
  assert.equal(c.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
  const h = new Headers(c.init.headers)
  assert.equal(h.get("x-api-key"), KEY)
  assert.equal(h.get("x-api-resource-id"), "volc.bigasr.auc_turbo")
  assert.equal(h.get("x-api-sequence"), "-1")
  assert.match(h.get("x-api-request-id"), /^[0-9a-f-]{36}$/)
  assert.equal(c.body.audio.data, Buffer.from(AUDIO).toString("base64"))
  assert.equal(c.body.audio.url, undefined)
  assert.deepEqual(c.body.request, {
    model_name: "bigmodel",
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    enable_speaker_info: true,
    show_utterances: true,
  })
})

test("verbose_json gives segments with seconds and the speaker", async () => {
  const { loaded } = await plugin([{ code: "20000000", body: FINISHED }])
  const out = await call(loaded, "bigasr-flash", { response_format: "verbose_json", language: "en" }, { file: AUDIO })
  assert.equal(out.status, 200)
  assert.deepEqual(out.json, {
    task: "transcribe",
    language: "en",
    duration: 11,
    text: "And so, my fellow Americans.",
    segments: [
      { id: 0, start: 0.19, end: 0.9, text: "And so,", speaker: "1" },
      { id: 1, start: 0.95, end: 2.5, text: "my fellow Americans.", speaker: "2" },
    ],
  })
})

test("text answers plain text", async () => {
  const { loaded } = await plugin([{ code: "20000000", body: FINISHED }])
  const out = await call(loaded, "bigasr-flash", { response_format: "text" }, { file: AUDIO })
  assert.equal(out.status, 200)
  assert.match(out.type, /^text\/plain/)
  assert.equal(out.text, "And so, my fellow Americans.")
})

test("an unsupported response_format is refused before Volcengine", async () => {
  const { loaded, up } = await plugin()
  assert.equal((await call(loaded, "bigasr-flash", { response_format: "srt" }, { file: AUDIO })).status, 400)
  assert.equal(up.calls.length, 0)
})

test("an ISO 639-1 language becomes Volcengine's locale; a locale passes through", async () => {
  const { loaded, up } = await plugin([{ code: "20000000", body: FINISHED }, { code: "20000000", body: FINISHED }])
  await call(loaded, "bigasr-flash", { language: "zh" }, { file: AUDIO })
  await call(loaded, "bigasr-flash", { language: "ja-JP" }, { file: AUDIO })
  assert.equal(up.calls[0].body.audio.language, "zh-CN")
  assert.equal(up.calls[1].body.audio.language, "ja-JP")
})

test("an unknown language is refused before Volcengine", async () => {
  const { loaded, up } = await plugin()
  assert.equal((await call(loaded, "bigasr-flash", { language: "xx" }, { file: AUDIO })).status, 400)
  assert.equal(up.calls.length, 0)
})

test("flash also takes an audio URL instead of a file", async () => {
  const { loaded, up } = await plugin([{ code: "20000000", body: FINISHED }])
  const out = await call(loaded, "bigasr-flash", { audio_url: "https://example.com/a.wav" })
  assert.equal(out.status, 200)
  assert.deepEqual(up.calls[0].body.audio, { url: "https://example.com/a.wav" })
})

test("flash silence is an empty transcript", async () => {
  const { loaded } = await plugin([{ code: "20000003" }])
  const out = await call(loaded, "bigasr-flash", { response_format: "verbose_json" }, { file: AUDIO })
  assert.equal(out.status, 200)
  assert.equal(out.json.text, "")
  assert.deepEqual(out.json.segments, [])
})

test("a flash rejection keeps Volcengine's status in the error", async () => {
  const { loaded } = await plugin([{ code: "45000151", message: "bad format" }])
  const out = await call(loaded, "bigasr-flash", {}, { file: AUDIO })
  assert.equal(out.status, 502)
  assert.match(out.json.error.message, /status=45000151, message=bad format/)
})

test("flash with neither a file nor an audio URL is refused", async () => {
  const { loaded, up } = await plugin()
  assert.equal((await call(loaded, "bigasr-flash", {})).status, 400)
  assert.equal(up.calls.length, 0)
})

// ---------- standard models: long-audio jobs ----------

test("an upload to a standard model explains the job protocol instead of guessing", async () => {
  const { loaded, up } = await plugin()
  const out = await call(loaded, "seed-asr-2.0", {}, { file: AUDIO })
  assert.equal(out.status, 400)
  assert.match(out.json.error.message, /bigasr-flash/)
  assert.match(out.json.error.message, /volc_operation=submit/)
  assert.equal(up.calls.length, 0)
})

for (const [model, resource] of [["seed-asr-2.0", "volc.seedasr.auc"], ["bigasr-1.0", "volc.bigasr.auc"]]) {
  test(`submit sends ${model}'s job to ${resource}`, async () => {
    const { loaded, up } = await plugin([{ code: "20000000" }])
    const out = await call(loaded, model, submit({ language: "zh-CN" }))
    assert.equal(out.status, 200)
    assert.deepEqual(out.json, { object: "volcengine.asr.task", task_id: TASK, status: "submitted" })
    const [c] = up.calls
    assert.equal(c.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit")
    const h = new Headers(c.init.headers)
    assert.equal(h.get("x-api-key"), KEY)
    assert.equal(h.get("x-api-resource-id"), resource)
    assert.equal(h.get("x-api-request-id"), TASK)
    assert.equal(h.get("x-api-sequence"), "-1")
    assert.deepEqual(c.body, {
      user: { uid: TASK },
      audio: { url: "https://example.com/a.mp3", format: "mp3", language: "zh-CN" },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        enable_speaker_info: true,
        show_utterances: true,
        enable_lid: true,
        enable_emotion_detection: true,
        enable_gender_detection: true,
        show_speech_rate: true,
        show_volume: true,
      },
    })
  })
}

test("submit leaves language out when none is given", async () => {
  const { loaded, up } = await plugin([{ code: "20000000" }])
  await call(loaded, "seed-asr-2.0", submit())
  assert.deepEqual(up.calls[0].body.audio, { url: "https://example.com/a.mp3", format: "mp3" })
})

test("a submit rejection keeps Volcengine's status and the task id", async () => {
  const { loaded } = await plugin([{ code: "45000001", message: "invalid audio url" }])
  const out = await call(loaded, "seed-asr-2.0", submit())
  assert.equal(out.status, 502)
  assert.equal(out.json.error.type, "volcengine_asr_error")
  assert.match(out.json.error.message, /submit failed: status=45000001, message=invalid audio url/)
  assert.match(out.json.error.message, new RegExp(TASK))
})

for (const [name, fields] of [
  ["unknown operation", job("delete", { volc_task_id: TASK })],
  ["non-UUID task id", submit({ volc_task_id: "../query" })],
  ["plain-HTTP audio URL", submit({ audio_url: "http://example.com/a.mp3" })],
  ["unsupported format", submit({ audio_format: "flac" })],
  ["malformed language", submit({ language: "zh_CN; drop" })],
  ["query without a task id", job("query")],
]) {
  test(`a bad job request is refused before Volcengine: ${name}`, async () => {
    const { loaded, up } = await plugin()
    const out = await call(loaded, "seed-asr-2.0", fields)
    assert.equal(out.status, 400)
    assert.equal(out.json.error.type, "invalid_request_error")
    assert.equal(up.calls.length, 0)
  })
}

test("query returns the finished Volcengine payload as is", async () => {
  const { loaded, up } = await plugin([{ code: "20000000", body: FINISHED }])
  const out = await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
  assert.equal(out.status, 200)
  assert.deepEqual(out.json, {
    object: "volcengine.asr.task",
    task_id: TASK,
    status: "completed",
    provider_status: "20000000",
    payload: FINISHED,
  })
  const [c] = up.calls
  assert.equal(c.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query")
  assert.deepEqual(c.body, {})
  const h = new Headers(c.init.headers)
  assert.equal(h.get("x-api-request-id"), TASK)
  assert.equal(h.get("x-api-resource-id"), "volc.seedasr.auc")
  assert.equal(h.get("x-api-sequence"), null)
})

for (const [code, status] of [["20000003", "silent"], ["20000001", "processing"], ["20000002", "queued"]]) {
  test(`query maps ${code} to ${status}`, async () => {
    const { loaded } = await plugin([{ code }])
    const out = await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
    assert.equal(out.status, 200)
    assert.deepEqual(out.json, { object: "volcengine.asr.task", task_id: TASK, status, provider_status: code })
  })
}

test("a query failure keeps Volcengine's status", async () => {
  const { loaded } = await plugin([{ code: "45000006", message: "audio could not be downloaded" }])
  const out = await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
  assert.equal(out.status, 502)
  assert.match(out.json.error.message, /query failed: status=45000006, message=audio could not be downloaded/)
})

test("an unreachable Volcengine is a 502 transport error", async () => {
  const { loaded } = await plugin([new TypeError("fetch failed")])
  const out = await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
  assert.equal(out.status, 502)
  assert.equal(out.json.error.type, "transport_error")
})

// ---------- readiness ----------

for (const code of ["45000000", "45000092"]) {
  test(`readiness counts ${code} (an unknown task under an accepted key) as ready`, async () => {
    const { loaded, up } = await plugin([{ code }])
    const out = await call(loaded, "seed-asr-2.0", job("readiness"))
    assert.equal(out.status, 200)
    assert.deepEqual(out.json, { object: "volcengine.asr.readiness", ready: true, provider_status: code, reason: "authenticated_unknown_request" })
    assert.equal(up.calls[0].url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query")
  })
}

for (const [answer, reason] of [
  [{ code: "45000010" }, "provider_rejected"],
  [{ code: "45000030" }, "provider_rejected"],
  [{ code: "45000000", http: 403 }, "unexpected_response"],
  [{ code: "20000000" }, "unexpected_response"],
  [new TypeError("fetch failed"), "transport_error"],
]) {
  test(`readiness fails closed: ${reason} ${answer.code ?? answer.message}`, async () => {
    const { loaded } = await plugin([answer])
    const out = await call(loaded, "seed-asr-2.0", job("readiness"))
    assert.equal(out.status, 200)
    assert.equal(out.json.ready, false)
    assert.equal(out.json.reason, reason)
  })
}

// ---------- the key ----------

test("the key is the signed-in account's, read for every request", async () => {
  let key = "first-key"
  const up = upstream([{ code: "20000001" }, { code: "20000001" }])
  const hooks = await VolcengineASRPlugin({}, { fetch: up.fetch })
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key }))
  await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
  key = "second-key"
  await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK }))
  assert.equal(new Headers(up.calls[0].init.headers).get("x-api-key"), "first-key")
  assert.equal(new Headers(up.calls[1].init.headers).get("x-api-key"), "second-key")
})

test("a signed-out account fails closed without calling Volcengine", async () => {
  let auth = { type: "api", key: KEY }
  const up = upstream([])
  const hooks = await VolcengineASRPlugin({}, { fetch: up.fetch })
  const loaded = await hooks.auth.loader(async () => auth)
  auth = undefined
  await assert.rejects(call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK })), /signed out/)
  assert.equal(up.calls.length, 0)
})

test("no answer ever contains the API key", async () => {
  const { loaded } = await plugin([
    { code: "45000001", message: `bad key ${KEY}` },
    new Error(`socket ${KEY}`),
    { code: "45000151", message: `format ${KEY}` },
  ])
  const outs = [
    await call(loaded, "seed-asr-2.0", submit()),
    await call(loaded, "seed-asr-2.0", job("query", { volc_task_id: TASK })),
    await call(loaded, "bigasr-flash", {}, { file: AUDIO }),
  ]
  for (const out of outs) assert.ok(!out.text.includes(KEY), out.text)
})
