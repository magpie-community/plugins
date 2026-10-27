// Kiro caches but says nothing of it (X, zeewell: "kiro 代理的模型缓存每次都是 0%").
// A real reply to claude-sonnet-4.5 (2026-10-24, a 9k-token prompt sent
// twice) ends with these events and no others: no tokenUsage in the
// metadataEvent, so no input, output or cache counts at all, while the
// second call was billed 0.048 credits to the first's 0.091. kiro-cli
// 2.32's own trace log shows the same reply as MetadataEvent { total_tokens:
// None, uncached_input_tokens: None, …, cache_read_input_tokens: None }.
// The plugin said cache_read_input_tokens 0, and magpie showed "cache 0%"
// on every Kiro request; it now says the cache is unknown.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { events, reply } = _internal

// frame is one AWS event-stream message with string headers.
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}

const stream = (...fs) =>
  new ReadableStream({
    start(c) {
      for (const f of fs) c.enqueue(f)
      c.close()
    },
  })

const ev = (type, payload) => frame({ ":message-type": "event", ":event-type": type }, payload)
// the events of the real reply, as Kiro sent them
const kiroReply = () =>
  stream(
    ev("assistantResponseEvent", { content: "OK" }),
    ev("metadataEvent", { stopReason: "END_TURN" }),
    ev("contextUsageEvent", { contextUsagePercentage: 11.032500267028809 }),
    ev("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.09107998018242124 }),
  )
const ask = (body, streaming) => reply(events(body, "claude-sonnet-4.5", 0), "claude-sonnet-4.5", streaming)

async function finalUsage(res, streaming) {
  if (!streaming) return (await res.json()).usage
  let last
  for (const line of (await res.text()).split("\n"))
    if (line.startsWith("data: ")) {
      const d = JSON.parse(line.slice(6))
      if (d.type === "message_delta") last = d.usage
    }
  return last
}

test("a reply with no token counts says its cache is unknown, not 0", async () => {
  for (const s of [false, true]) {
    const u = await finalUsage(await ask(kiroReply(), s), s)
    expect(u.magpie_cache_unknown).toBe(true)
    expect(u).not.toHaveProperty("cache_read_input_tokens")
    expect(u).not.toHaveProperty("cache_creation_input_tokens")
    expect(u.output_tokens).toBeGreaterThan(0)
  }
})

test("a reply whose metadataEvent counts tokens tells them, cache included", async () => {
  for (const s of [false, true]) {
    const body = stream(
      ev("assistantResponseEvent", { content: "OK" }),
      ev("metadataEvent", { stopReason: "END_TURN", tokenUsage: { uncachedInputTokens: 120, outputTokens: 3, cacheReadInputTokens: 9000, cacheWriteInputTokens: 0, totalTokens: 9123 } }),
    )
    const u = await finalUsage(await ask(body, s), s)
    expect(u).toEqual({ input_tokens: 120, output_tokens: 3, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 })
  }
})
