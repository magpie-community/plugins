// magpie's /v1/audio/speech and /v1/audio/transcriptions on a WorkBuddy
// plan (#1617): sent as WorkBuddy's desktop app sends its own read-aloud
// and dictation (workbuddy-server tts/service.ts, asr/service.ts, both
// builds): POST /agenttool/v1/tts {text} answered as SSE of base64 16 kHz
// PCM, and POST /agenttool/v1/asr with the recording as "audio" answered
// {code, msg, text}.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const later = () => Date.now() + 3600_000
const auth = { type: "oauth", access: "tok", refresh: "r", expires: later(), uid: "u-1", domain: "www.codebuddy.cn", enterpriseId: "ent-1" }

// serve answers WorkBuddy's paths with answer(path, init) and records
// every request
const serve = (answer) => {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    sent.push({ url: String(url), path: u.pathname, headers: new Headers(init?.headers), body: init?.body })
    return answer(u.pathname, init)
  }
  return sent
}

const loaded = async (plugin = WorkBuddyAuthPlugin, a = auth, magpie) => {
  const hooks = await plugin({ client: {}, magpie })
  return hooks.auth.loader(async () => a)
}

// pcm is n samples of a ramp, as 16-bit LE
const pcm = (n, from = 0) => {
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(((from + i) * 37) % 30000, i * 2)
  return b
}
const sse = (...events) => events.map(([type, data]) => `event: ${type}\ndata: ${data}\n\n`).join("")

const speak = (opts, body) =>
  opts.fetch("plugin://workbuddy/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("a speech request goes to /agenttool/v1/tts as the app sends it, and comes back as WAV", async () => {
  const a = pcm(800)
  const b = pcm(400, 800)
  const sent = serve(() => new Response(sse(["audio", a.toString("base64")], ["audio", b.toString("base64")]), { headers: { "content-type": "text/event-stream" } }))
  const res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好", voice: "alloy" })
  expect(res.status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("https://copilot.tencent.com/agenttool/v1/tts")
  expect(JSON.parse(sent[0].body)).toEqual({ text: "你好" })
  const h = sent[0].headers
  expect(h.get("authorization")).toBe("Bearer tok")
  expect(h.get("content-type")).toBe("application/json")
  expect(h.get("x-user-id")).toBe("u-1")
  expect(h.get("x-domain")).toBe("www.codebuddy.cn")
  expect(h.get("x-enterprise-id")).toBe("ent-1")
  expect(h.get("x-tenant-id")).toBe("ent-1")
  // the app's server asks through Node's fetch, with none of a chat's client headers
  expect(h.get("user-agent")).toBe("node")
  for (const k of ["x-ide-name", "x-agent-type", "x-product", "x-conversation-id", "x-stainless-lang"]) expect(h.has(k)).toBe(false)
  expect(res.headers.get("content-type")).toBe("audio/wav")
  const wav = Buffer.from(await res.arrayBuffer())
  expect(wav.subarray(0, 4).toString()).toBe("RIFF")
  expect(wav.readUInt32LE(24)).toBe(16000)
  expect(wav.readUInt16LE(22)).toBe(1)
  expect(wav.readUInt16LE(34)).toBe(16)
  expect(wav.subarray(44).equals(Buffer.concat([a, b]))).toBe(true)
})

test("WorkBuddy AI's speech goes to its own host, and a personal account sends no enterprise", async () => {
  const sent = serve(() => new Response(sse(["audio", pcm(10).toString("base64")])))
  const res = await speak(await loaded(WorkBuddyAIAuthPlugin, { ...auth, domain: "www.workbuddy.ai", enterpriseId: undefined }), { model: "workbuddy-tts", input: "hello" })
  expect(res.status).toBe(200)
  expect(sent[0].url).toBe("https://www.workbuddy.ai/agenttool/v1/tts")
  expect(sent[0].headers.has("x-enterprise-id")).toBe(false)
  expect(sent[0].headers.get("x-domain")).toBe("www.workbuddy.ai")
})

test("pcm is answered at OpenAI's 24 kHz, the rate a client asking for pcm plays it at", async () => {
  serve(() => new Response(sse(["audio", pcm(1600).toString("base64")])))
  const res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好", response_format: "pcm" })
  expect(res.headers.get("content-type")).toBe("audio/pcm")
  expect((await res.arrayBuffer()).byteLength).toBe(2400 * 2)
})

test("a long text goes in pieces of at most 1000 bytes, cut at a sentence's end", async () => {
  const sentence = "这是一句用来朗读的话。" // 11 chars, 33 bytes
  const input = sentence.repeat(100)
  const sent = serve(() => new Response(sse(["audio", pcm(4).toString("base64")])))
  const res = await speak(await loaded(), { model: "workbuddy-tts", input })
  expect(res.status).toBe(200)
  const texts = sent.map((s) => JSON.parse(s.body).text)
  expect(texts.length).toBeGreaterThan(3)
  for (const t of texts) {
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1000)
    expect(t.endsWith("。")).toBe(true)
  }
  expect(texts.join("")).toBe(input)
  expect(Buffer.from(await res.arrayBuffer()).length).toBe(44 + texts.length * 8)
  // with no break to cut at, where the bytes run out
  for (const t of _internal.spokenParts("字".repeat(700))) expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1000)
})

test("an SSE error event, and a refusal, are said with WorkBuddy's words", async () => {
  serve(() => new Response(sse(["audio", pcm(4).toString("base64")], ["error", "text too long"])))
  let res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好" })
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toContain("text too long")

  serve(() => Response.json({ code: 14001, msg: "voice output is off for this account" }, { status: 403 }))
  res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好" })
  expect(res.status).toBe(403)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect((await res.json()).error.message).toContain("voice output is off for this account (code 14001)")
})

test("a bad request is answered here, never sent", async () => {
  const sent = serve(() => new Response(""))
  const opts = await loaded()
  expect((await speak(opts, { model: "workbuddy-tts", input: "  " })).status).toBe(400)
  expect((await speak(opts, { model: "workbuddy-tts", input: "hi", response_format: "ogg" })).status).toBe(400)
  expect((await opts.fetch("plugin://workbuddy/v1/audio/translations", { method: "POST", body: new FormData() })).status).toBe(400)
  expect(sent).toHaveLength(0)
})

// form is OpenAI's transcription request, as magpie sends it on
const form = (fields, audio = Buffer.from("RIFF....WAVEfmt fake"), name = "recording.wav") => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  f.append("file", new Blob([audio], { type: "audio/wav" }), name)
  return f
}
const hear = async (opts, fields, ...rest) => {
  const body = new Response(form(fields, ...rest))
  return opts.fetch("plugin://workbuddy/v1/audio/transcriptions", {
    method: "POST",
    headers: { "content-type": body.headers.get("content-type") },
    body: new Uint8Array(await body.arrayBuffer()),
  })
}

test("a transcription goes to /agenttool/v1/asr as the app's \"audio\", and comes back in OpenAI's shape", async () => {
  const audio = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt the recording")
  const sent = serve(() => Response.json({ code: 0, msg: "success", text: "你好" }))
  const res = await hear(await loaded(), { model: "workbuddy-transcribe", response_format: "json", language: "zh" }, audio, "dictation.wav")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ text: "你好" })
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("https://copilot.tencent.com/agenttool/v1/asr")
  const h = sent[0].headers
  expect(h.get("authorization")).toBe("Bearer tok")
  expect(h.get("x-user-id")).toBe("u-1")
  expect(h.get("x-enterprise-id")).toBe("ent-1")
  expect(h.get("user-agent")).toBe("node")
  expect(h.has("content-type")).toBe(false) // fetch writes the form's own
  const f = sent[0].body
  expect(f).toBeInstanceOf(FormData)
  expect([...f.keys()]).toEqual(["audio"])
  const file = f.get("audio")
  expect(file.name).toBe("dictation.wav")
  // as the part said it, as the app sends it: not the audio/x-wav Bun's
  // form reader makes of it
  expect(file.type).toBe("audio/wav")
  expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true)
})

test("text is answered as text, and WorkBuddy's failure code as a failure", async () => {
  serve(() => Response.json({ code: 0, text: "你好" }))
  let res = await hear(await loaded(), { model: "workbuddy-transcribe", response_format: "text" })
  expect(res.headers.get("content-type")).toStartWith("text/plain")
  expect(await res.text()).toBe("你好")

  serve(() => Response.json({ code: 13002, msg: "audio format not supported" }))
  res = await hear(await loaded(), { model: "workbuddy-transcribe" })
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toContain("audio format not supported (code 13002)")
})

test("a transcription format WorkBuddy has no timings for, or no file, is refused unsent", async () => {
  const sent = serve(() => Response.json({ code: 0, text: "x" }))
  const opts = await loaded()
  expect((await hear(opts, { model: "workbuddy-transcribe", response_format: "verbose_json" })).status).toBe(400)
  expect((await opts.fetch("plugin://workbuddy/v1/audio/transcriptions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400)
  expect(sent).toHaveLength(0)
})

test("a bare 401 is WorkBuddy's refusal of the request: passed on, nothing renewed", async () => {
  const sent = serve(() => new Response('{"code":401,"msg":"no permission"}', { status: 401 }))
  const res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好" })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(sent.map((s) => s.path)).toEqual(["/agenttool/v1/tts"])
})

test("a 401 for the token itself is renewed once, as a chat's is", async () => {
  const sent = serve((path, init) => {
    if (path.endsWith("/token/refresh")) return Response.json({ code: 0, data: { accessToken: "tok-2", refreshToken: "r-2", expiresIn: 3600 } })
    if (new Headers(init?.headers).get("authorization") === "Bearer tok")
      return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="copilot", error="invalid_token"' } })
    return new Response(sse(["audio", pcm(4).toString("base64")]))
  })
  const res = await speak(await loaded(), { model: "workbuddy-tts", input: "你好" })
  expect(res.status).toBe(200)
  expect(sent.map((s) => s.path)).toEqual(["/agenttool/v1/tts", "/v2/plugin/auth/token/refresh", "/agenttool/v1/tts"])
  expect(sent[2].headers.get("authorization")).toBe("Bearer tok-2")
})

test("an API key's 401 for the token is the key's refusal, renewed never", async () => {
  const sent = serve(() => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } }))
  const res = await speak(await loaded(WorkBuddyAuthPlugin, { type: "api", key: "ck_test_key_123456" }), { model: "workbuddy-tts", input: "你好" })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  expect(sent).toHaveLength(1)
  expect(sent[0].headers.get("x-api-key")).toBe("ck_test_key_123456")
  expect(sent[0].headers.has("x-domain")).toBe(false)
})

for (const [plugin, site] of [[WorkBuddyAuthPlugin, "workbuddy"], [WorkBuddyAIAuthPlugin, "workbuddy-ai"]]) {
  test(`${site}: lists its TTS and speech recognition as models that give no chat`, async () => {
    serve(() => Response.json({ code: 0, data: { agents: [{ name: "cli", models: ["m"] }], models: [{ id: "m", name: "M" }] } }))
    const hooks = await plugin({ client: {} })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    expect(cfg.provider[site].models["workbuddy-tts"].modalities).toEqual({ input: ["text"], output: ["audio"] })
    expect(cfg.provider[site].models["workbuddy-transcribe"].modalities).toEqual({ input: ["audio"], output: [] })
    const ms = await hooks.provider.models({ id: site, models: {} }, { auth })
    expect(Object.keys(ms)).toEqual(["m", "workbuddy-tts", "workbuddy-transcribe"])
    const out = (id) => Object.entries(ms[id].capabilities.output).filter(([, v]) => v).map(([k]) => k)
    expect(out("m")).toEqual(["text"])
    expect(out("workbuddy-tts")).toEqual(["audio"])
    expect(out("workbuddy-transcribe")).toEqual([])
    expect(ms["workbuddy-transcribe"].capabilities.input.audio).toBe(true)
  })

  test(`${site}: with "Free models only" on, neither is listed nor sent`, async () => {
    const magpie = { option: (p, k) => p === site && k === _internal.FREE_ONLY }
    const sent = serve(() => Response.json({ code: 0, data: { agents: [{ name: "cli", models: ["m"] }], models: [{ id: "m", name: "M", credits: "x0.00" }] } }))
    const hooks = await plugin({ client: {}, magpie })
    const ms = await hooks.provider.models({ id: site, models: {} }, { auth })
    expect(Object.keys(ms)).not.toContain("workbuddy-tts")
    sent.length = 0
    const opts = await hooks.auth.loader(async () => auth)
    expect((await speak(opts, { model: "workbuddy-tts", input: "你好" })).status).toBe(404)
    expect(sent).toHaveLength(0)
  })
}
