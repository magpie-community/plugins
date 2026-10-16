// Devin's Gemini models answer "There is an issue with this request, please
// try a different model" (invalid_argument, 400 in magpie) to a request
// offering a tool whose schema has a list type, an array with no items or
// with a list or true as items, or properties or an enum with no type, at
// any depth (7eleven on Discord: ZCode on gemini-4-argon). Each schema
// below was sent to gemini-4-argon on a real account and refused, and went
// through as built here; Claude models and swe-2 took every one, so their
// schemas go as they came.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

const sent = (b) =>
  Object.fromEntries(
    _internal
      .fields(b)
      .filter((f) => f.num === 10 && f.wire === 2)
      .map((f) => {
        const g = _internal.fields(f.data)
        return [dec.decode(g.find((h) => h.num === 1).data), JSON.parse(dec.decode(g.find((h) => h.num === 3).data))]
      }),
  )

const P = (props) => ({ type: "object", properties: props })
// refused by gemini-4-argon, each on its own
const REFUSED = {
  typeList: P({ a: { type: ["string", "null"] } }),
  typeListOne: P({ a: { type: ["string"] } }),
  typeListTwo: P({ a: { type: ["string", "number"] } }),
  noItems: P({ a: { type: "array" } }),
  itemsTrue: P({ a: { type: "array", items: true } }),
  itemsList: P({ a: { type: "array", items: [{ type: "string" }] } }),
  deepNoItems: P({ a: { type: "object", properties: { b: { type: "array" } } } }),
  unionNoItems: P({ a: { anyOf: [{ type: "array" }, { type: "null" }] } }),
  propsNoType: P({ a: { properties: { b: { type: "string" } } } }),
  enumNoType: P({ a: { enum: ["x", "y"] } }),
}

const chatWith = (parameters) => ({
  messages: [{ role: "user", content: "ok" }],
  tools: [{ type: "function", function: { name: "t", description: "t", parameters } }],
})

// what Devin's Gemini models refuse, anywhere in the schema
function refused(s, at = "$") {
  if (!s || typeof s !== "object" || Array.isArray(s)) return []
  const out = []
  if (Array.isArray(s.type)) out.push(at + " list type")
  if (s.type === "array" && (!s.items || typeof s.items !== "object" || Array.isArray(s.items))) out.push(at + " items")
  if (s.type === undefined && (s.properties || s.enum)) out.push(at + " no type")
  for (const [k, v] of Object.entries(s.properties ?? {})) out.push(...refused(v, at + "." + k))
  for (const k of ["anyOf", "oneOf", "allOf"]) for (const [i, v] of (s[k] ?? []).entries()) out.push(...refused(v, `${at}.${k}[${i}]`))
  if (s.items) out.push(...refused(s.items, at + "[]"))
  return out
}

for (const [name, parameters] of Object.entries(REFUSED)) {
  test(`${name}: goes to a Gemini model in a shape it takes`, () => {
    const before = JSON.stringify(parameters)
    const got = sent(_internal.build(chatWith(parameters), "gemini-4-argon-medium", "k")).t
    expect(refused(got)).toEqual([])
    expect(JSON.stringify(parameters)).toBe(before)
  })
  test(`${name}: goes to a Claude model as it came`, () => {
    expect(sent(_internal.build(chatWith(parameters), "claude-opus-5-5-high", "k")).t).toEqual(parameters)
    expect(sent(_internal.build(chatWith(parameters), "swe-2-high", "k")).t).toEqual(parameters)
  })
}

test("a list type keeps what it allowed", () => {
  const g = (s) => _internal.geminiSchema(s)
  expect(g({ type: ["string", "null"], description: "d" })).toEqual({ type: "string", nullable: true, description: "d" })
  expect(g({ type: ["string"] })).toEqual({ type: "string" })
  expect(g({ type: ["string", "number", "null"] })).toEqual({ nullable: true, anyOf: [{ type: "string" }, { type: "number" }] })
  expect(g({ type: ["array", "null"] })).toEqual({ type: "array", nullable: true, items: {} })
  expect(g({ type: "array", items: [{ type: "string" }] })).toEqual({ type: "array", items: { type: "string" } })
  expect(g({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toEqual({ type: "array", items: {} })
  expect(g({ enum: [1, 2] })).toEqual({ type: "integer", enum: [1, 2] })
  expect(g({ enum: ["x", null] })).toEqual({ type: "string", enum: ["x"], nullable: true })
  expect(g({ enum: ["x", 1] })).toEqual({})
})

test("a schema Gemini takes goes as it came", () => {
  const parameters = {
    type: "object",
    properties: {
      a: { anyOf: [{ type: "string" }, { type: "null" }] },
      b: { type: "array", items: { type: "string", enum: ["x"] } },
      c: { $ref: "#/$defs/x" },
      d: { const: "k" },
    },
    $defs: { x: { type: "object", properties: { y: { type: "integer" } } } },
    required: ["a"],
  }
  expect(sent(_internal.build(chatWith(parameters), "gemini-4-argon-medium", "k")).t).toEqual(parameters)
})
