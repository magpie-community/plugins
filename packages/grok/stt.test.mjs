// Speech to text: magpie's /v1/audio/transcriptions (OpenAI's multipart
// form) goes to xAI's own /v1/stt, which Grok Build's voice dictation uses,
// signed as the CLI signs; images in a Responses request go on untouched.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin, _internal } from "./index.mjs"

noRealGrok()

const real = globalThis.fetch
const root = mkdtempSync(join(tmpdir(), "grok-stt-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = real
})

let home
beforeEach(() => {
  home = mkdtempSync(join(root, "home-"))
  const expires = Date.now() + 3600_000
  writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key: "tok-1", email: "g@x.ai", expires_at: new Date(expires).toISOString() } }))
})

// audio bytes that aren't UTF-8, as a WAV's are
const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])

// the multipart body a client sends, its boundary fixed
function form(fields) {
  const b = "----magpietest"
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), Buffer.from(audio), Buffer.from(`\r\n--${b}--\r\n`))
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` }
}

async function ask(fields, path = "/audio/transcriptions", answer) {
  const auth = { type: "oauth", refresh: home, access: "tok-1", expires: Date.now() + 3600_000, accountId: "g@x.ai" }
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth)
  const sent = []
  globalThis.fetch = async (url, init) => {
    const got = init.body instanceof FormData ? init.body : null
    sent.push({ url: String(url), auth: init.headers.get("Authorization"), form: got })
    return answer ? answer() : new Response(JSON.stringify({ text: "Hello world.", language: "en", duration: 2.01, words: [{ text: "Hello", start: 0.04, end: 0.24 }] }), { headers: { "content-type": "application/json" } })
  }
  const f = form(fields)
  const res = await opts.fetch(`https://cli-chat-proxy.grok.com/v1${path}`, { method: "POST", headers: { "content-type": f.type }, body: f.body })
  return { res, sent }
}

test("a transcription goes to xAI's /v1/stt with the audio byte for byte and no OpenAI model", async () => {
  const { res, sent } = await ask({ model: "grok-4.7", language: "en", prompt: "x" })
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("https://api.x.ai/v1/stt")
  expect(sent[0].auth).toBe("Bearer tok-1")
  expect(sent[0].form.has("model")).toBe(false)
  expect(sent[0].form.get("language")).toBe("en")
  expect(new Uint8Array(await sent[0].form.get("file").arrayBuffer())).toEqual(audio)
  expect(await res.json()).toEqual({ text: "Hello world." })
})

test("text and verbose_json answer in OpenAI's shapes", async () => {
  const t = await ask({ response_format: "text" })
  expect(t.res.headers.get("content-type")).toMatch(/^text\/plain/)
  expect(await t.res.text()).toBe("Hello world.")
  const v = await (await ask({ response_format: "verbose_json" })).res.json()
  expect(v).toEqual({ task: "transcribe", language: "en", duration: 2.01, text: "Hello world.", words: [{ word: "Hello", start: 0.04, end: 0.24 }] })
})

test("a format xAI can't make, and a translation, are 400s that send nothing", async () => {
  for (const [fields, path] of [[{ response_format: "srt" }], [{}, "/audio/translations"]]) {
    const { res, sent } = await ask(fields, path)
    expect(res.status).toBe(400)
    expect(sent).toEqual([])
  }
})

test("xAI's refusal comes back with its status and words", async () => {
  const { res } = await ask({}, "/audio/transcriptions", () => new Response('{"error":"Field \'language\' is required"}', { status: 400 }))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("language")
})

test("an image in a Responses request goes to Grok as it was sent", () => {
  const body = JSON.stringify({
    model: "grok-4.7",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }],
  })
  expect(_internal.rewrite(body)).toBe(body)
})
