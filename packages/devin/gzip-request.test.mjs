// Devin's nginx turns away a request body past 10 MiB on the wire (413
// Request Entity Too Large), so a long turn goes gzipped, a short one as it
// was, at the size the devin CLI gzips from (8,083 bytes plain, 8,333
// gzipped, captured from 3000.11.92).
import { expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { _internal } from "./index.mjs"

const unframe = (b) => ({ flags: b[0], data: b.subarray(5, 5 + new DataView(b.buffer, b.byteOffset).getUint32(1)) })

test("a short message goes as it is", () => {
  const msg = new TextEncoder().encode("hi")
  const { flags, data } = unframe(_internal.frame(msg))
  expect(flags).toBe(0)
  expect([...data]).toEqual([...msg])
})

test("the CLI's sizes: 8,083 bytes go as they are, 8,333 gzipped", () => {
  expect(unframe(_internal.frame(new Uint8Array(8083))).flags).toBe(0)
  expect(unframe(_internal.frame(new Uint8Array(8333))).flags).toBe(1)
})

test("a long message goes gzipped, and inflates to itself", () => {
  const msg = new TextEncoder().encode("x".repeat(12 << 20))
  const out = _internal.frame(msg)
  const { flags, data } = unframe(out)
  expect(flags).toBe(1)
  expect(out.length).toBeLessThan(1 << 20)
  expect(Buffer.from(gunzipSync(data)).equals(Buffer.from(msg))).toBe(true)
})

const sent = async (content) => {
  let seen
  const was = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = init
    return new Response("{}", { status: 400 })
  }
  try {
    await _internal.complete({ key: "k", server: "https://devin.test", families: [] }, { model: "swe-2", messages: [{ role: "user", content }] })
  } finally {
    globalThis.fetch = was
  }
  return seen
}

test("a long chat request is gzipped and says so", async () => {
  const seen = await sent("y".repeat(200 << 10))
  expect(seen.headers["Connect-Content-Encoding"]).toBe("gzip")
  expect(unframe(seen.body).flags).toBe(1)
  // the CLI asks for no encoding of the reply; Devin gzips it anyway
  expect(seen.headers["Connect-Accept-Encoding"]).toBeUndefined()
})

test("a short chat request names no encoding, as the CLI's doesn't", async () => {
  const seen = await sent("hi")
  expect(unframe(seen.body).flags).toBe(0)
  expect(seen.headers["Connect-Content-Encoding"]).toBeUndefined()
  expect(seen.headers["Connect-Accept-Encoding"]).toBeUndefined()
})
