import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { events, reply, sealReasoning } = _internal

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
const SIG = ".KTR~~eyJlbmNyeXB0aW9uUmVnaW9uIjpudWxsLCJtaW50ZWRBdE1zIjoxNzk0MDU1MjcyODg0LCJtb2RlbEhhc2giOiJ5RUxWOXhiY2Z3dlUiLCJzbG90cyI6W10sInYiOjF9"
const SCOPE = "account-region-model"
const signed = () => sealReasoning({ reasoningText: { text: "...", signature: SIG } }, SCOPE)
const body = () => stream(
  ev("assistantResponseEvent", { content: "OK", modelId: "auto" }),
  ev("reasoningContentEvent", { signature: SIG, text: "..." }),
  ev("metadataEvent", { stopReason: "END_TURN" }),
)

test("reasoning sent with its signature in one event keeps the signature", async () => {
  const res = await reply(events(body(), "auto", 0, false, SCOPE), "auto", false)
  const j = await res.json()
  expect(j.content).toEqual([{ type: "text", text: "OK" }, { type: "thinking", thinking: "...", signature: signed() }])
})

test("streamed, the signature follows the reasoning in its block", async () => {
  const res = await reply(events(body(), "auto", 0, false, SCOPE), "auto", true)
  const out = await res.text()
  expect(out).toContain(JSON.stringify({ type: "thinking_delta", thinking: "..." }))
  expect(out).toContain(JSON.stringify({ type: "signature_delta", signature: signed() }))
})
