import { expect, test } from "bun:test"
import { _internal as p } from "./index.mjs"

test("Value oneofs retain false, empty strings and null presence", () => {
  expect([...p.valueMsg(null).out()]).toEqual([8, 0])
  expect([...p.valueMsg(false).out()]).toEqual([32, 0])
  expect([...p.valueMsg("").out()]).toEqual([26, 0])
  const object = { default: false, enum: ["", null, true], nested: { number: 1.25, negative: -3.5 } }
  expect(p.structOf(p.structPB(object).out())).toEqual(object)
})

test("doubles use protobuf's little endian wire representation", () => {
  expect([...p.valueMsg(1.25).out()]).toEqual([17, 0, 0, 0, 0, 0, 0, 244, 63])
})

test("unsigned varints work beyond uint32 and decode the full uint64 range", () => {
  for (const n of [2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER]) expect(p.fields(new p.PB().v(1, n).out())[0].v).toBe(n)
  expect(p.fields(Uint8Array.from([8, ...Array(9).fill(255), 1]))[0].v).toBe(2n ** 64n - 1n)
  expect(() => new p.PB().uv(-1)).toThrow()
  expect(() => new p.PB().uv(Infinity)).toThrow()
})

for (const [name, bytes] of [
  ["unterminated varint", [8, 128]], ["oversized uint64", [8, ...Array(10).fill(255)]],
  ["truncated bytes", [10, 100, 65]], ["truncated double", [17, 0]],
  ["truncated float", [13, 0]], ["zero field number", [0]], ["invalid wire type", [15]],
]) test(`rejects ${name}`, () => expect(() => p.fields(Uint8Array.from(bytes))).toThrow())

test("ordinary strings remain strings, including proto-looking content", () => {
  const object = { text: "\u000fprotobuf wire type 7 [assistant]" }
  expect(p.structOf(p.structPB(object).out())).toEqual(object)
})

test("a __proto__ map key remains data rather than changing the object prototype", () => {
  const object = JSON.parse('{"__proto__":{"polluted":true}}')
  const out = p.structOf(p.structPB(object).out())
  expect(Object.hasOwn(out, "__proto__")).toBe(true)
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  expect(out.polluted).toBeUndefined()
})
