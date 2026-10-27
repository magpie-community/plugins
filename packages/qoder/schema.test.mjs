// Qoder CN's kmodel_latest (Kimi K3.1 Pro) fails a chat whose tools hold a
// oneOf with no type, even of objects only, and takes it with "type":
// "object" beside it (congee949, #378). The parameters are the issue's own.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, typedUnions } = _internal
const m = { key: "kmodel_latest", config: { key: "kmodel_latest" }, context: 128_000 }
const ab = [
  { type: "object", properties: { mode: { type: "string", const: "a" } } },
  { type: "object", properties: { mode: { type: "string", const: "b" } } },
]
const nested = { type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: { type: "object", properties: { y: { oneOf: ab } }, required: ["y"] } } }

test("a oneOf of objects with no type goes typed object, the client's tool untouched", () => {
  const parameters = { type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: { oneOf: ab } } }
  const chat = { messages: [{ role: "user", content: "Do not call tools. Reply exactly OK." }], tools: [{ type: "function", function: { name: "probe", description: "Diagnostic placeholder.", parameters } }] }
  const before = structuredClone(chat)
  const sent = qoderBody(chat, m).tools[0].function.parameters
  expect(sent.$defs.X).toEqual({ oneOf: ab, type: "object" })
  expect(sent.properties.x).toEqual({ $ref: "#/$defs/X" })
  expect(chat).toEqual(before)
  expect(typedUnions(nested).$defs.X.properties.y.type).toBe("object")
})

test("a oneOf whose branches are $refs to objects is typed; mixed, anyOf, missing, external and circular are left", () => {
  const refs = { type: "object", properties: { s: { $ref: "#/$defs/__schema0" } }, $defs: { __schema0: { oneOf: [{ $ref: "#/$defs/__schema1" }, { $ref: "#/$defs/__schema3" }] }, __schema1: { type: "object" }, __schema3: { $ref: "#/$defs/__schema4" }, __schema4: { type: "object" } } }
  expect(typedUnions(refs).$defs.__schema0.type).toBe("object")
  const left = { type: "object", properties: {
    mixed: { oneOf: [ab[0], { type: "string" }] },
    any: { anyOf: ab },
    missing: { oneOf: [ab[0], { $ref: "#/$defs/Nope" }] },
    external: { oneOf: [ab[0], { $ref: "other.json#/X" }] },
    loop: { oneOf: [ab[0], { $ref: "#/$defs/A" }] },
    examples: { type: "array", examples: [{ oneOf: ab }] },
  }, $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } } }
  expect(typedUnions(left)).toEqual(left)
})
