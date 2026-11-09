// Kiro turns away an image whose Base64 is over 5 MiB (magpie-community/
// plugins#428, imwaco): Codex's view_image gave a PNG of 4,171,428 bytes,
// 5,561,904 as Base64, and Kiro answered
//   messages.130.content.2.image.source.base64: image exceeds 5 MB maximum:
//   5561904 bytes > 5242880 bytes (IMAGE_SIZE_EXCEEDED)
// on that turn and every later one, text-only ones too, as the image stays in
// history. The fixtures are built here at those sizes: no network, no file.
import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { _internal } from "./index.mjs"

const { buildKiro, kiroBody, generate, IMAGE_LIMIT } = _internal

const LIMIT = 5242880
const REPORTED_RAW = 4171428
const REPORTED_B64 = 5561904

// ---- PNG fixtures ----------------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = (w, h) => {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(w, 0)
  d.writeUInt32BE(h, 4)
  d[8] = 8 // bit depth
  d[9] = 2 // RGB
  return chunk("IHDR", d)
}

// png is a w×h RGB PNG of noise (seeded, so the same each run: the worst case
// for a codec) or of flat grey, made exactly size bytes long with a private
// ancillary chunk, as a file can carry bytes no decoder looks at.
function png(w, h, { noise = true, size } = {}) {
  const rows = Buffer.alloc(h * (1 + w * 3), 0x80)
  if (noise) {
    let x = 0x9e3779b9
    for (let i = 0; i < rows.length; i++) {
      if (i % (1 + w * 3) === 0) {
        rows[i] = 0
        continue
      }
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      rows[i] = x & 0xff
    }
  } else for (let y = 0; y < h; y++) rows[y * (1 + w * 3)] = 0
  const parts = [SIG, ihdr(w, h), chunk("IDAT", deflateSync(rows, { level: noise ? 0 : 9 })), chunk("IEND", Buffer.alloc(0))]
  let file = Buffer.concat(parts)
  if (size != null) {
    const pad = size - file.length - 12
    if (pad < 0) throw new Error(`a ${w}x${h} PNG is ${file.length} bytes, over ${size}`)
    file = Buffer.concat([parts[0], parts[1], chunk("pdNg", Buffer.alloc(pad, 0x2a)), parts[2], parts[3]])
  }
  return file
}

// a header saying 20000×20000 (400M pixels) with almost nothing behind it
function bomb(size) {
  const f = Buffer.concat([SIG, ihdr(20000, 20000), chunk("IDAT", deflateSync(Buffer.alloc(1000))), chunk("IEND", Buffer.alloc(0))])
  return Buffer.concat([f.subarray(0, 33), chunk("pdNg", Buffer.alloc(size - f.length - 12, 0x2a)), f.subarray(33)])
}

const b64 = (buf) => buf.toString("base64")
const meta = (s) => new Bun.Image(Buffer.from(s, "base64")).metadata()

// the reporter's image: a 1389×1000 noise PNG, 4,171,428 bytes
const reported = png(1389, 1000, { size: REPORTED_RAW })
const REPORTED = b64(reported)

// ---- requests --------------------------------------------------------------------------

const tools = [{ name: "view_image", description: "View a local image", input_schema: { type: "object", properties: { path: { type: "string" } } } }]
const img = (data, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data } })

// Codex's turn: view_image answered with the image, then (when follow) a
// reply and a text-only question, the image still in history
function codex(data, follow = false) {
  const messages = [
    { role: "user", content: [{ type: "text", text: "做一张联系表，然后看一下" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_view1", name: "view_image", input: { path: "/tmp/sheet.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_view1", content: [img(data)] }] },
  ]
  if (follow)
    messages.push(
      { role: "assistant", content: [{ type: "text", text: "It is a contact sheet of twelve photos." }] },
      { role: "user", content: [{ type: "text", text: "把图片压缩一下" }] },
    )
  return { model: "claude-opus-5.5", system: [{ type: "text", text: "You are Codex." }], messages, tools }
}

const parse = async (req) => JSON.parse(await kiroBody(req, "claude-opus-5.5", "", 0)).conversationState
const users = (s) => [...(s.history ?? []), { userInputMessage: s.currentMessage.userInputMessage }].map((e) => e.userInputMessage).filter(Boolean)
const imagesOf = (s) => users(s).flatMap((u) => u.images ?? [])
// the conversation with its images' bytes left out: what fitting may not change
const shape = (s) => {
  const c = structuredClone(s)
  delete c.conversationId
  for (const u of users(c)) for (const i of u.images ?? []) i.source.bytes = "…"
  return c
}

// ---- tests -----------------------------------------------------------------------------

test("the fixture is the reported image's size: under 5 MiB as a file, over it as Base64", () => {
  expect(IMAGE_LIMIT).toBe(LIMIT)
  expect(reported.length).toBe(REPORTED_RAW)
  expect(REPORTED.length).toBe(REPORTED_B64)
  // and Kiro is sent it unchanged without the fitting, which is what failed
  const s = JSON.parse(buildKiro(codex(REPORTED), "claude-opus-5.5", "", 0)).conversationState
  expect(s.currentMessage.userInputMessage.images[0].source.bytes.length).toBe(REPORTED_B64)
})

test("the reported tool image goes under the limit as an image Kiro can read, the conversation otherwise the same", async () => {
  const req = codex(REPORTED)
  const before = structuredClone(req)
  const s = await parse(req)
  const [i] = imagesOf(s)
  expect(imagesOf(s)).toHaveLength(1)
  expect(i.source.bytes.length).toBeLessThanOrEqual(LIMIT)
  // it decodes, as the kind it is declared as, the same shape
  const m = await meta(i.source.bytes)
  expect(m.format).toBe(i.format)
  expect(m.width / m.height).toBeCloseTo(1389 / 1000, 2)
  // the conversation is the one buildKiro makes, image bytes and format aside
  const plain = JSON.parse(buildKiro(req, "claude-opus-5.5", "", 0)).conversationState
  const a = shape(s)
  const b = shape(plain)
  for (const u of [...users(a), ...users(b)]) for (const x of u.images ?? []) delete x.format
  expect(a).toEqual(b)
  expect(s.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
    { toolUseId: "call_view1", status: "success", content: [{ text: "(no output)" }] },
  ])
  // the caller's request is untouched
  expect(req).toEqual(before)
}, 60_000)

test("a text-only turn after the image goes too: the image in history is fitted, nothing else moves", async () => {
  const req = codex(REPORTED, true)
  const s = await parse(req)
  const plain = JSON.parse(buildKiro(req, "claude-opus-5.5", "", 0)).conversationState
  // the image stays where the latest-image rule left it, in history
  expect(s.currentMessage.userInputMessage.images).toBeUndefined()
  expect(s.currentMessage.userInputMessage.content).toBe("把图片压缩一下")
  const where = (st) => users(st).map((u) => (u.images ?? []).length)
  expect(where(s)).toEqual(where(plain))
  expect(where(s).reduce((a, b) => a + b)).toBe(1)
  for (const i of imagesOf(s)) expect(i.source.bytes.length).toBeLessThanOrEqual(LIMIT)
  expect(s.history.length).toBe(plain.history.length)
  expect(s.history.map((e) => Object.keys(e)[0])).toEqual(plain.history.map((e) => Object.keys(e)[0]))
}, 60_000)

test("an image the user attached is fitted the same way", async () => {
  const req = { model: "claude-opus-5.5", messages: [{ role: "user", content: [img(REPORTED), { type: "text", text: "what is this?" }] }] }
  const s = await parse(req)
  const [i] = s.currentMessage.userInputMessage.images
  expect(i.source.bytes.length).toBeLessThanOrEqual(LIMIT)
  expect((await meta(i.source.bytes)).format).toBe(i.format)
  expect(s.currentMessage.userInputMessage.content).toBe("what is this?")
}, 60_000)

test("at the limit an image is sent byte for byte; one Base64 quad over, it is fitted", async () => {
  // 3,932,160 bytes is 5,242,880 Base64 characters, no padding;
  // 3,932,159 is the same length ending in "="; 3,932,161 is 5,242,884
  const at = b64(png(64, 48, { noise: false, size: 3932160 }))
  const padded = b64(png(64, 48, { noise: false, size: 3932159 }))
  const over = b64(png(64, 48, { noise: false, size: 3932161 }))
  expect([at.length, padded.length, over.length]).toEqual([LIMIT, LIMIT, LIMIT + 4])
  expect(padded.endsWith("=")).toBe(true)
  for (const data of [at, padded]) {
    const [i] = imagesOf(await parse(codex(data)))
    expect(i.source.bytes).toBe(data)
    expect(i.format).toBe("png")
  }
  const [i] = imagesOf(await parse(codex(over)))
  expect(i.source.bytes.length).toBeLessThan(LIMIT)
  const m = await meta(i.source.bytes)
  expect([m.format, m.width, m.height]).toEqual(["png", 64, 48])
})

test("small images beside a large one are left as they are, in their order", async () => {
  const small = b64(png(8, 8, { noise: false }))
  const req = codex(REPORTED)
  req.messages[2].content[0].content = [img(small), img(REPORTED), { type: "text", text: "two images" }, img(small, "image/png")]
  const s = await parse(req)
  const got = s.currentMessage.userInputMessage.images
  expect(got).toHaveLength(3)
  expect(got[0]).toEqual({ format: "png", source: { bytes: small } })
  expect(got[2]).toEqual({ format: "png", source: { bytes: small } })
  expect(got[1].source.bytes.length).toBeLessThanOrEqual(LIMIT)
  expect(s.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content).toEqual([{ text: "two images" }])
}, 60_000)

test("an image that can't be read, or claims too many pixels, becomes a note and the turn still goes", async () => {
  const junk = b64(Buffer.alloc(4_000_000, 0x5a))
  const huge = b64(bomb(4_000_000))
  expect(junk.length).toBeGreaterThan(LIMIT)
  for (const [data, why] of [
    [junk, "it couldn't be read as an image"],
    [huge, "it has too many pixels to resize"],
  ]) {
    const s = await parse(codex(data, true))
    expect(imagesOf(s)).toEqual([])
    const noted = users(s).find((u) => u.content.includes("was left out"))
    expect(noted.content).toContain(why)
    expect(noted.content).toContain("5.0 MB")
    // the note names no bytes and no path
    expect(noted.content.length).toBeLessThan(300)
    expect(noted.content).not.toContain("/tmp")
    // the tool's answer is still paired with its call
    expect(noted.userInputMessageContext.toolResults[0].toolUseId).toBe("call_view1")
    expect(s.currentMessage.userInputMessage.content).toBe("把图片压缩一下")
  }
})

test("one image is fitted once: again on the next turn, and when sent twice at once", async () => {
  const realImage = Bun.Image
  let made = 0
  Bun.Image = class extends realImage {
    constructor(...a) {
      super(...a)
      made++
    }
  }
  try {
    const flat = b64(png(64, 48, { noise: false, size: 3932161 + 3 * 7 }))
    const [a, b] = await Promise.all([parse(codex(flat)), parse(codex(flat))])
    const once = made
    const c = await parse(codex(flat, true))
    expect(made).toBe(once)
    expect(imagesOf(a)[0].source.bytes).toBe(imagesOf(b)[0].source.bytes)
    expect(imagesOf(c)[0].source.bytes).toBe(imagesOf(a)[0].source.bytes)
  } finally {
    Bun.Image = realImage
  }
})

test("Kiro is sent the fitted image, in one request", async () => {
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    // the experiment read before the chat (plugins#842) isn't a send of the image
    if (new URL(String(url)).pathname !== "/featureConfiguration") sent.push({ url: String(url), body: init.body })
    return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
  }
  try {
    const res = await generate(async () => ({ region: "us-east-1", token: "t" }), {}, codex(REPORTED, true))
    await res.text()
  } finally {
    globalThis.fetch = real
  }
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse")
  const s = JSON.parse(sent[0].body).conversationState
  expect(imagesOf(s)).toHaveLength(1)
  for (const i of imagesOf(s)) expect(i.source.bytes.length).toBeLessThanOrEqual(LIMIT)
}, 60_000)


test("a host without Bun.Image sends a note in the image's place", async () => {
  const realImage = Bun.Image
  Bun.Image = undefined
  try {
    const s = await parse(codex(b64(png(64, 48, { noise: false, size: 3932161 + 3 * 11 }))))
    expect(imagesOf(s)).toEqual([])
    expect(s.currentMessage.userInputMessage.content).toContain("this plugin host can't resize images")
  } finally {
    Bun.Image = realImage
  }
})
