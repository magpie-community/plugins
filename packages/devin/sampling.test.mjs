// Devin answers "an internal error occurred" to a temperature or top_p of
// exactly 0 (Hermes's command approvals send temperature 0): a 0 goes to
// Devin as 1e-6, any other value as it came.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

// sampling is the temperature and top_p in the request's field 8.
const sampling = (chat) => {
  const f8 = _internal.fields(_internal.build(chat, "claude-opus-5-5", "k")).find((f) => f.num === 8)
  const out = {}
  const b = f8.data
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < b.length; ) {
    const key = b[i++]
    if ((key & 7) === 0) while (b[i++] & 0x80);
    else if ((key & 7) === 1) {
      out[key >> 3] = view.getFloat64(i, true)
      i += 8
    } else throw new Error(`unexpected wire type in field 8: ${key & 7}`)
  }
  return { temperature: out[5], top_p: out[8] }
}

const say = { messages: [{ role: "user", content: "hi" }] }

test("a temperature or top_p of 0 goes to Devin as 1e-6", () => {
  expect(sampling({ ...say, temperature: 0 })).toEqual({ temperature: 1e-6, top_p: 0.95 })
  expect(sampling({ ...say, top_p: 0 })).toEqual({ temperature: 1, top_p: 1e-6 })
  expect(sampling({ ...say, temperature: -0, top_p: 0 })).toEqual({ temperature: 1e-6, top_p: 1e-6 })
})

test("any other temperature or top_p goes as it came, and none as Devin's defaults", () => {
  expect(sampling(say)).toEqual({ temperature: 1, top_p: 0.95 })
  expect(sampling({ ...say, temperature: 0.2, top_p: 1 })).toEqual({ temperature: 0.2, top_p: 1 })
  expect(sampling({ ...say, temperature: 1e-6 })).toEqual({ temperature: 1e-6, top_p: 0.95 })
})
