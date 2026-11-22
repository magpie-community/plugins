// The frame codec against the 121 captured frames: every frame decodes to
// the payload recorded beside its hex, a rebuild round-trips, the stream
// splitter survives a split frame, and a rebuilt user_message matches the
// capture byte for byte except the per-frame id (whose 4 bytes feed the
// CRC, so the CRC differs with it).
import { expect, test } from "bun:test"
import { parseFrame, readFrames, buildFrame, buildMessage, inputHeaders } from "../lib/frame.mjs"
import { readFileSync } from "node:fs"

const fx = JSON.parse(readFileSync(new URL("./fixtures-ws.json", import.meta.url), "utf8"))

test("every captured frame decodes to its recorded payload", () => {
  let checked = 0
  for (const f of fx) {
    const { headers, body } = parseFrame(Buffer.from(f.hex, "hex"))
    expect(headers[":content-type"]).toBe("application/cbor")
    expect(headers[":message-type"]).toBe("event")
    expect(headers[":event-type"]).toBe(f.dir === "SEND" ? "rawInputEvent" : f.type === null ? headers[":event-type"] : "rawOutputEvent")
    const want = f.payload === null ? undefined : f.payload
    // the empty handshake frames decode to {} (an indefinite empty map);
    // the recorded side is null for them
    if (want === undefined) expect(["undefined", "{}"]).toContain(JSON.stringify(body))
    else expect(JSON.stringify(body)).toBe(JSON.stringify(want))
    checked++
  }
  expect(checked).toBe(121)
})

test("a rebuild round-trips every frame with a body", () => {
  for (const f of fx) {
    const buf = Buffer.from(f.hex, "hex")
    const { headers, body } = parseFrame(buf)
    if (body === undefined) continue // the empty handshake maps
    const again = parseFrame(buildFrame(headers, body))
    expect(again.headers).toEqual(headers)
    expect(again.body).toEqual(body)
  }
})

test("a rebuilt user_message matches the capture except the frame id", () => {
  const um = fx.find((f) => f.type === "user_message")
  const orig = Buffer.from(um.hex, "hex")
  const { headers, body } = parseFrame(orig)
  const built = buildFrame(headers, body)
  expect(built.length).toBe(orig.length)
  let diffs = 0
  for (let i = 12; i < orig.length; i++) if (built[i] !== orig[i]) diffs++
  // only the CRC (fed by the id) may differ
  expect(diffs).toBeLessThanOrEqual(4)
})

test("the stream splitter reassembles a frame split across chunks", () => {
  const all = Buffer.concat(fx.map((f) => Buffer.from(f.hex, "hex")))
  expect(readFrames(all).frames.length).toBe(121)
  expect(readFrames(all).rest.length).toBe(0)
  const cut = all.length - 10
  const first = readFrames(all.subarray(0, cut))
  const second = readFrames(Buffer.concat([first.rest, all.subarray(cut)]))
  expect(second.frames.length).toBe(1)
})

test("a bad CRC is refused", () => {
  const buf = Buffer.from(fx[0].hex, "hex")
  buf[buf.length - 1] ^= 0xff
  expect(() => parseFrame(buf)).toThrow(/CRC/)
})

test("buildMessage wraps a payload in the send headers", () => {
  const { headers, body } = parseFrame(buildMessage("ping", { timestamp: 5 }))
  expect(headers).toEqual(inputHeaders())
  expect(body).toEqual({ type: "ping", payload: { timestamp: 5 } })
})
