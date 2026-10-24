import { expect, test } from "bun:test"
import { _internal as w } from "./index.mjs"

test("Struct and Value skip known field numbers with unrelated wire types", () => {
  const p = new w.PB().v(1, 1).m(1, new w.PB().s(1, "value").v(2, 1))
  expect(w.structOf(p.out())).toEqual({ value: null })
  expect(w.valueOf(new w.PB().v(5, 1).v(6, 1).out())).toBeNull()
  const list = new w.PB().v(1, 1).m(1, w.valueMsg(false))
  expect(w.valueOf(new w.PB().m(6, list).out())).toEqual([false])
})

test("malformed Struct bytes and unsupported wire types throw controlled errors", () => {
  for (const bytes of [undefined, Buffer.from([15]), Buffer.from([10, 3, 10])]) {
    try { w.structOf(bytes); throw new Error("expected decoding error") }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(TypeError)
      expect(error.message).toMatch(/protobuf/)
    }
  }
})

test("deeply nested Struct values fail before overflowing the call stack", () => {
  let value = w.valueMsg(false)
  for (let i = 0; i < 70; i++) value = new w.PB().m(6, new w.PB().m(1, value))
  expect(() => w.valueOf(value.out())).toThrow(/nesting is too deep/)
})

test("SSE bounds a line across chunks and releases the source on overflow", async () => {
  let returned = 0
  const body = (async function* () {
    try {
      yield Buffer.alloc(w.MAX_SSE_LINE, 97)
      yield Buffer.from("a\n")
    } finally { returned++ }
  })()
  await expect(w.sseEvents(body).next()).rejects.toThrow(/SSE line exceeded/)
  expect(returned).toBe(1)
})

test("the SSE limit applies per line, not per chunk or whole conversation", async () => {
  const line = "a".repeat(w.MAX_SSE_LINE)
  const body = (async function* () { yield Buffer.from(line + "\n" + line + "\ndata: AQ\n") })()
  const it = w.sseEvents(body)
  expect((await it.next()).value).toEqual(Buffer.from([1]))
  expect((await it.next()).done).toBe(true)
})
