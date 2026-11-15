// plainSchema, held to magpie's built-in (internal/gateway/codeassist.go)
// by its tests: codeassist_test.go, antigravity_array_items_test.go,
// antigravity_enum_blank_test.go and antigravity_root_union_test.go.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { plainSchema } = _internal
const ps = (s) => plainSchema(JSON.parse(s))

test("a tool's schema as the built-in sends it", () => {
  const s = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object",
    "properties":{"path":{"type":["string","null"],"format":"uri"},"mode":{"const":"r"},"opts":{"$ref":"#/$defs/Opts"},
    "n":{"anyOf":[{"type":"integer"},{"type":"null"}]}},"required":["path","gone"],"additionalProperties":false,
    "$defs":{"Opts":{"type":"object","properties":{"deep":{"type":"boolean","default":false}}}}}`
  expect(ps(s)).toEqual(
    JSON.parse(`{"properties":{"mode":{"enum":["r"]},"n":{"nullable":true,"type":"integer"},"opts":{"properties":{"deep":{"type":"boolean"}},"type":"object"},"path":{"nullable":true,"type":"string"}},"required":["path"],"type":"object"}`),
  )
})

test("every array has items, however deep", () => {
  const got = ps(`{"type":"object","$defs":{"Tags":{"type":"array","description":"tags"}},
  "properties":{
    "grid":{"type":"array","items":{"type":"array"}},
    "maybe":{"anyOf":[{"type":"null"},{"type":"array"}]},
    "one":{"oneOf":[{"type":"array","minItems":1},{"type":"string"}]},
    "both":{"allOf":[{"type":"object","properties":{"list":{"type":"array"}}}]},
    "tags":{"$ref":"#/$defs/Tags"},
    "opt":{"type":["array","null"]},
    "kept":{"type":"array","items":{"type":"string"}},
    "deep":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"cells":{"type":"array"}}}}}}
  }}`)
  expect(got).toEqual(
    JSON.parse(`{"type":"object","properties":{
    "grid":{"type":"array","items":{"type":"array","items":{}}},
    "maybe":{"type":"array","items":{},"nullable":true},
    "one":{"type":"array","items":{},"minItems":1},
    "both":{"type":"object","properties":{"list":{"type":"array","items":{}}}},
    "tags":{"type":"array","items":{},"description":"tags"},
    "opt":{"type":"array","items":{},"nullable":true},
    "kept":{"type":"array","items":{"type":"string"}},
    "deep":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"cells":{"type":"array","items":{}}}}}}}
  }}`),
  )
  expect(JSON.stringify(ps(`{"type":"object","properties":{"s":{"type":"string"}}}`))).not.toContain("items")
})

test("blank enum values are dropped (#5235)", () => {
  const out = ps(
    `{"type":"object","properties":{"StatusMessage":{"type":"object","properties":{"operationStatus":{"allOf":[{"enum":["processing","warning","error",""],"type":"string","x-enum-varnames":["A","B","C","D"]}],"description":"'', 'error', 'processing'","example":"error"}}},` +
      `"blank":{"type":"string","enum":[""," "]},"c":{"type":"string","const":""},"n":{"enum":["a",1,""]}}}`,
  )
  const op = out.properties.StatusMessage.properties.operationStatus
  expect(op.type).toBe("string")
  expect(op.enum).toEqual(["processing", "warning", "error"])
  for (const k of ["blank", "c", "n"]) expect(out.properties[k].enum).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('""')
})

const rg = `{"type":"object","properties":{"pattern":{"type":"string"},"cursor":{"type":"string"}},"oneOf":[{"required":["pattern"],"not":{"required":["cursor"]}},{"required":["cursor"],"not":{"required":["pattern"]}}]}`

test.each([
  ["root oneOf", rg, `{"type":"object","properties":{"pattern":{"type":"string"},"cursor":{"type":"string"}}}`],
  ["root anyOf", `{"type":"object","properties":{"a":{"type":"string"}},"anyOf":[{"required":["a"]},{"not":{"required":["a"]}}]}`, `{"type":"object","properties":{"a":{"type":"string"}}}`],
  ["properties only, no type", `{"properties":{"a":{"type":"string"}},"oneOf":[{"required":["a"]}]}`, `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`],
  [
    "nested oneOf",
    `{"type":"object","properties":{"q":{"type":"object","description":"query","properties":{"pattern":{"type":"string"},"cursor":{"type":"string"}},"oneOf":[{"required":["pattern"],"not":{"required":["cursor"]}},{"required":["cursor"],"not":{"required":["pattern"]}}]}},"required":["q"]}`,
    `{"type":"object","properties":{"q":{"type":"object","description":"query","properties":{"pattern":{"type":"string"},"cursor":{"type":"string"}}}},"required":["q"]}`,
  ],
  [
    "nested anyOf",
    `{"type":"object","properties":{"q":{"type":"object","properties":{"a":{"type":"integer"}},"anyOf":[{"required":["a"]},{"type":"null"}]}}}`,
    `{"type":"object","properties":{"q":{"type":"object","properties":{"a":{"type":"integer"}},"required":["a"],"nullable":true}}}`,
  ],
  [
    "branches add fields",
    `{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind"],"oneOf":[{"properties":{"kind":{"const":"a"},"x":{"type":"string"}},"required":["kind","x"]},{"properties":{"kind":{"const":"b"},"y":{"type":"number"}},"required":["kind","y"]}]}`,
    `{"type":"object","properties":{"kind":{"type":"string"},"x":{"type":"string"},"y":{"type":"number"}},"required":["kind"]}`,
  ],
  [
    "every branch requires it",
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"anyOf":[{"required":["a","b"]},{"required":["a"]}]}`,
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a"]}`,
  ],
  [
    "root allOf",
    `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"allOf":[{"properties":{"b":{"type":"string"}},"required":["b"]},{"not":{"required":["c"]}}]}`,
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a","b"]}`,
  ],
  [
    "nested allOf",
    `{"type":"object","properties":{"q":{"type":"object","properties":{"a":{"type":"string"}},"allOf":[{"required":["a"]}]}}}`,
    `{"type":"object","properties":{"q":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}}}`,
  ],
  [
    "allOf beside oneOf",
    `{"type":"object","properties":{"a":{"type":"string"}},"allOf":[{"properties":{"b":{"type":"string"}}}],"oneOf":[{"required":["a"]},{"required":["b"]}]}`,
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}}}`,
  ],
  ["typed scalar", `{"type":"string","description":"d","anyOf":[{"format":"date"},{"format":"uuid"}]}`, `{"type":"string","description":"d"}`],
  [
    "bare union still its first branch",
    `{"type":"object","properties":{"v":{"description":"value","anyOf":[{"type":"null"},{"type":"integer"},{"type":"string"}]}}}`,
    `{"type":"object","properties":{"v":{"type":"integer","description":"value","nullable":true}}}`,
  ],
])("a union keeps its own shape: %s", (_, input, want) => {
  expect(ps(input)).toEqual(JSON.parse(want))
})

test("a reference to itself, or deeper than 32, ends", () => {
  const out = ps(`{"type":"object","properties":{"node":{"$ref":"#/$defs/Node"}},"$defs":{"Node":{"type":"object","properties":{"next":{"$ref":"#/$defs/Node"},"v":{"type":"string"}}}}}`)
  expect(out.properties.node.properties.next).toEqual({ type: "object" })
  expect(out.properties.node.properties.v).toEqual({ type: "string" })
  expect(ps(`{"type":"object","properties":{"me":{"$ref":"#"}}}`).properties.me).toEqual({ type: "object" })
  expect(ps(`{"type":"object","properties":{"x":{"$ref":"#/$defs/Gone"}}}`).properties.x).toEqual({ type: "object" })
})

test("exclusive bounds and tuples", () => {
  expect(ps(`{"type":"number","exclusiveMinimum":1,"exclusiveMaximum":9,"maximum":5}`)).toEqual({ type: "number", minimum: 1, maximum: 5 })
  expect(ps(`{"type":"array","prefixItems":[{"type":"string"},{"type":"string"}]}`)).toEqual({ type: "array", items: { type: "string" } })
  expect(ps(`{"type":"array","prefixItems":[{"type":"string"},{"type":"number"}]}`)).toEqual({ type: "array", items: {} })
  expect(ps(`{"type":"array","items":false}`)).toEqual({ type: "array", items: {}, maxItems: 0 })
})
