// What a long conversation carries that Devin turns away with "There is an
// issue with this request, please try a different model"
// (invalid_argument), each seen on a real Devin account (2026-11-16,
// a1pha1nthefog on X): it stays in the conversation, so every turn after
// failed the same while a new session worked. A picture whose bytes aren't
// the type it is said to be, a user prompt of white space alone, a thinking
// signature Devin didn't give, and a conversation past the model's window.
import { afterEach, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { _internal } from "./index.mjs"

const { PB, frame, fields, buildMessages, build, completeMessages, familiesOf, SNAPSHOT } = _internal
const dec = new TextDecoder()
const enc = new TextEncoder()
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64")
const SIG = "EqQBCkgIBRABGAIiQL2xYzRvY0RzZWNyZXRzaWduYXR1cmU="

// prompts is each ChatMessagePrompt a request sends: its role, text, the
// types of its images and its thinking's signature
const prompts = (body) =>
  fields(body)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const p = { role: 0, text: "", images: [], signature: null }
      for (const g of fields(f.data)) {
        if (g.num === 2) p.role = g.n
        else if (g.num === 3) p.text = dec.decode(g.data)
        else if (g.num === 10) p.images.push(dec.decode(fields(g.data).find((h) => h.num === 2).data))
        else if (g.num === 12) p.signature = dec.decode(g.data)
      }
      return p
    })
const unframe = (body) => {
  const b = new Uint8Array(body)
  return b[0] & 1 ? new Uint8Array(gunzipSync(b.subarray(5))) : b.subarray(5)
}

const end = (obj) => {
  const b = enc.encode(JSON.stringify(obj))
  const out = new Uint8Array(5 + b.length)
  out[0] = 2
  new DataView(out.buffer).setUint32(1, b.length)
  out.set(b, 5)
  return out
}
const refused = () => new Response(end({ error: { code: "invalid_argument", message: "There is an issue with this request, please try a different model." } }))
const answered = () =>
  new Response(new Blob([frame(new PB().str(3, "ok").done()), frame(new PB().varint(5, 1).bytes(7, new PB().varint(2, 10).varint(3, 1).done()).done()), end({})]))

const ctx = { key: "k", server: "https://devin.test", families: familiesOf(SNAPSHOT) }
// sent is each request's prompts, as Devin is asked, each answered by
// replies in turn
const asking = (...replies) => {
  const sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(prompts(unframe(init.body)))
    return replies[Math.min(sent.length, replies.length) - 1]()
  }
  return sent
}
const errOf = async (res) => JSON.parse(await res.text()).error.message

test("a picture goes as the type its bytes are, whatever it is said to be", () => {
  const img = (media_type, data) => ({ type: "image", source: { type: "base64", media_type, data } })
  const msg = buildMessages(
    {
      model: "claude-haiku-5-5",
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: [img("image/jpeg", PNG), { type: "text", text: "this" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [img("image/webp", PNG), img("image/png", JPEG), img("image/png", "AAAA")] }] },
      ],
    },
    "claude-haiku-5-5-low",
    "k",
  )
  expect(prompts(msg).flatMap((p) => p.images)).toEqual(["image/png", "image/png", "image/jpeg", "image/png"])
  const chat = build({ messages: [{ role: "user", content: [{ type: "text", text: "this" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + PNG } }] }] }, "swe-2-high", "k")
  expect(prompts(chat).flatMap((p) => p.images)).toEqual(["image/png"])
})

test("a user prompt of white space alone is not sent", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: " \n" },
  ]
  for (const p of [prompts(buildMessages({ messages: msgs }, "claude-haiku-5-5-low", "k")), prompts(build({ messages: msgs }, "swe-2-high", "k"))]) {
    expect(p.some((x) => x.role === 1 && x.text && !x.text.trim())).toBe(false)
    expect(p.at(-1).text).toBe("Please proceed with the task.")
  }
})

const signed = {
  model: "claude-haiku-5-5",
  max_tokens: 64,
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "greet", signature: SIG }, { type: "text", text: "hello" }] },
    { role: "user", content: "say ok" },
  ],
}

test("signed thinking Devin turns away is sent again once without its signature", async () => {
  const sent = asking(refused, answered)
  const res = await completeMessages(ctx, signed)
  expect(res.status).toBe(200)
  expect(sent.length).toBe(2)
  expect(sent[0].some((p) => p.signature === SIG)).toBe(true)
  expect(sent[1].some((p) => p.signature)).toBe(false)
  expect(sent[1].map((p) => p.text)).toEqual(sent[0].map((p) => p.text))
})

test("a request with no signed thinking is not sent again", async () => {
  const sent = asking(refused, answered)
  const res = await completeMessages(ctx, { ...signed, messages: [{ role: "user", content: "say ok" }] })
  expect(res.status).toBe(400)
  expect(sent.length).toBe(1)
  expect(await errOf(res)).toBe("There is an issue with this request, please try a different model.")
})

// claude-sonnet-4-6's window is 200,000 tokens; a token is estimated at
// four bytes
const filled = (bytes) => ({ model: "claude-sonnet-4-6", max_tokens: 64, messages: [{ role: "user", content: "x".repeat(bytes) }] })

test("turned away at half the window or more, it is too long for the model", async () => {
  asking(refused)
  const res = await completeMessages(ctx, filled(420_000))
  expect(res.status).toBe(400)
  const msg = await errOf(res)
  expect(msg).toStartWith("input is too long for the model's context: about 105")
  expect(msg).toContain("claude-sonnet-4-6's window of 200000")
})

test("turned away well inside the window, it is said as Devin said it", async () => {
  asking(refused)
  const res = await completeMessages(ctx, filled(300_000))
  expect(res.status).toBe(400)
  expect(await errOf(res)).toBe("There is an issue with this request, please try a different model.")
})

test("signed thinking still turned away without signatures, past half the window, is too long", async () => {
  const sent = asking(refused, refused)
  const res = await completeMessages(ctx, { ...signed, model: "claude-sonnet-4-6", messages: [{ role: "user", content: "x".repeat(420_000) }, ...signed.messages.slice(1)] })
  expect(sent.length).toBe(2)
  expect(await errOf(res)).toStartWith("input is too long for the model's context")
})
