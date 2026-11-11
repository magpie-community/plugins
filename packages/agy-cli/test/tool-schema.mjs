import assert from "node:assert/strict"
import test from "node:test"
import { expandToolSchema, TOOL_SEARCH_INPUT_SCHEMA } from "../tool-schema.mjs"
import { sanitizeInputSchema } from "../index.mjs"
import { ensureGeminiArrayItems } from "../array-items.mjs"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const fullPipeline = (schema) => ensureGeminiArrayItems(sanitizeInputSchema(expandToolSchema(schema)))

test("local $ref resolves $defs and definitions with RFC 6901 escapes and preserves sibling overrides", () => {
  const input = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: {
      "Options/a~b": {
        type: "object",
        description: "Base options",
        default: { path: "." },
        properties: {
          path: { type: "string", pattern: "^[^\\u0000]*$" },
          tags: { type: "array" },
        },
        required: ["path"],
      },
    },
    definitions: { Count: { type: "integer", minimum: 1, default: 2 } },
    properties: {
      options: { $ref: "#/$defs/Options~1a~0b", description: "Search options", default: { path: "/src" } },
      count: { $ref: "#/definitions/Count", maximum: 10, default: 5 },
    },
  }
  const original = structuredClone(input)
  const schema = fullPipeline(input)
  assert.equal(schema.$defs, undefined)
  assert.equal(schema.definitions, undefined)
  assert.equal(schema.$schema, undefined)
  assert.equal(schema.properties.options.type, "object")
  assert.equal(schema.properties.options.properties.path.type, "string")
  assert.equal(schema.properties.options.properties.path.pattern, "^[^\\x{0000}]*$")
  assert.ok(Array.isArray(schema.properties.options.properties.tags.items?.anyOf))
  assert.deepEqual(schema.properties.options.required, ["path"])
  assert.match(schema.properties.options.description, /^Search options \(Base options\)$/)
  assert.deepEqual(schema.properties.options.default, { path: "/src" })
  assert.equal(schema.properties.count.minimum, 1)
  assert.equal(schema.properties.count.maximum, 10)
  assert.equal(schema.properties.count.default, 5)
  assert.deepEqual(input, original)
})

test("allOf combines required fields, intersects bounds and enums, and prunes dangling required keys", () => {
  const schema = fullPipeline({
    allOf: [
      {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 20 },
          mode: { type: "string", enum: ["read", "write", "admin"] },
        },
        required: ["count"],
      },
      {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 5, maximum: 10 },
          mode: { type: "string", enum: ["write", "admin", "audit"] },
          path: { type: "string" },
        },
        required: ["path", "missing"],
      },
    ],
  })
  assert.equal(schema.allOf, undefined)
  assert.deepEqual(schema.required, ["count", "path"])
  assert.equal(schema.properties.count.minimum, 5)
  assert.equal(schema.properties.count.maximum, 10)
  assert.deepEqual(schema.properties.mode.enum, ["write", "admin"])
})

test("recursive and unresolved $ref terminate with explicit hints", () => {
  const schema = fullPipeline({
    type: "object",
    $defs: {
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    },
    properties: {
      head: { $ref: "#/$defs/Node" },
      remote: { $ref: "https://example.com/schema.json" },
      missing: { $ref: "#/$defs/Unknown" },
    },
  })
  assert.equal(schema.properties.head.type, "object")
  assert.equal(schema.properties.head.properties.next.type, "object")
  assert.equal(schema.properties.head.properties.next.properties, undefined)
  assert.match(schema.properties.head.properties.next.description, /Recursive schema/)
  assert.equal(schema.properties.remote.type, undefined)
  assert.equal(schema.properties.missing.type, undefined)
  assert.match(schema.properties.remote.description, /Unresolved schema reference/)
  assert.match(schema.properties.missing.description, /Unresolved schema reference/)
})

test("reference expansion is bounded for deep and exponentially shared DAGs", () => {
  const $defs = { End: { type: "string" } }
  for (let i = 0; i < 40; i++) {
    $defs[`Node${i}`] = {
      type: "object",
      properties: {
        a: { $ref: i === 39 ? "#/$defs/End" : `#/$defs/Node${i + 1}` },
        b: { $ref: i === 39 ? "#/$defs/End" : `#/$defs/Node${i + 1}` },
      },
    }
  }
  const schema = fullPipeline({ type: "object", $defs, properties: { root: { $ref: "#/$defs/Node0" } } })
  const text = JSON.stringify(schema)
  assert.match(text, /Schema expansion limit/)
  assert.ok(text.length < 500_000, String(text.length))
  assert.equal(schema.properties.root.type, "object")
  // Cut-off subtrees keep their object type instead of becoming strings.
  assert.doesNotMatch(text, /"type":"string","description":"Schema expansion limit/)
  assert.match(text, /"type":"object","description":"Schema expansion limit/)
})

test("const discriminators, boolean schemas, and additionalProperties booleans vs dictionary schemas are handled cleanly", () => {
  const schema = fullPipeline({
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { const: "read" },
      code: { const: 7 },
      forbidden: false,
      itemsTrue: { type: "array", items: true },
      strictNested: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
      },
      openDict: {
        type: "object",
        description: "CSS style overrides",
        additionalProperties: true,
      },
      envMap: {
        type: "object",
        description: "Environment variables",
        additionalProperties: { type: "string" },
      },
    },
  })
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.description, undefined)
  assert.deepEqual(schema.properties.mode, { type: "string", enum: ["read"] })
  assert.equal(schema.properties.code.const, undefined)
  assert.equal(schema.properties.code.type, "integer")
  assert.match(schema.properties.code.description, /Must equal: 7/)
  assert.equal(schema.properties.forbidden.type, undefined)
  assert.match(schema.properties.forbidden.description, /No value is allowed/)
  assert.ok(Array.isArray(schema.properties.itemsTrue.items?.anyOf))
  assert.equal(schema.properties.strictNested.additionalProperties, false)
  assert.equal(schema.properties.openDict.additionalProperties, true)
  assert.match(schema.properties.openDict.description, /Accepts arbitrary additional key-value properties/)
  assert.deepEqual(schema.properties.envMap.additionalProperties, { type: "string" })
  assert.match(schema.properties.envMap.description, /Additional properties: string/)
})

test("root and nested discriminated object unions lift properties, intersect required, and union method enums", () => {
  const cuaLike = fullPipeline({
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          method: { type: "string", const: "screenshot" },
          params: {
            type: "object",
            properties: { displayId: { type: "number" } },
            additionalProperties: false,
          },
        },
        required: ["method"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          method: { type: "string", const: "click" },
          params: {
            anyOf: [
              {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { target: { type: "string" } },
                required: ["target"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["method", "params"],
        additionalProperties: false,
      },
    ],
  })

  assert.equal(cuaLike.oneOf, undefined)
  assert.equal(cuaLike.anyOf, undefined)
  assert.equal(cuaLike.type, "object")
  assert.equal(cuaLike.additionalProperties, false)
  assert.deepEqual(cuaLike.required, ["method"])
  assert.deepEqual(cuaLike.properties.method, { type: "string", enum: ["screenshot", "click"] })
  assert.equal(cuaLike.properties.params.type, "object")
  assert.deepEqual(Object.keys(cuaLike.properties.params.properties).sort(), ["displayId", "target", "x", "y"])
  assert.equal(cuaLike.properties.params.required, undefined)
  assert.match(cuaLike.description, /Variants:/)
})

test("nullable Pydantic Optional fields and heterogeneous array item unions stay lossless and idempotent", () => {
  const input = {
    type: "object",
    $defs: {
      Filter: {
        type: "object",
        properties: { tag: { type: "string" } },
        required: ["tag"],
      },
    },
    properties: {
      colorScheme: {
        description: "Preferred theme",
        anyOf: [{ type: "string", enum: ["light", "dark"] }, { type: "null" }],
      },
      filter: {
        description: "Filter spec",
        anyOf: [{ $ref: "#/$defs/Filter" }, { type: "null" }],
      },
      mode: {
        anyOf: [{ type: "string", const: "auto" }, { type: "string" }],
      },
      order: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { type: { const: "divider" } },
              required: ["type"],
            },
          ],
        },
      },
    },
  }
  const once = fullPipeline(input)
  const twice = fullPipeline(once)

  assert.equal(once.properties.colorScheme.type, "string")
  assert.deepEqual(once.properties.colorScheme.enum, ["light", "dark"])
  assert.match(once.properties.colorScheme.description, /Nullable string/)

  assert.equal(once.properties.filter.type, "object")
  assert.deepEqual(once.properties.filter.properties, { tag: { type: "string" } })
  assert.deepEqual(once.properties.filter.required, ["tag"])
  assert.match(once.properties.filter.description, /Nullable object/)

  assert.equal(once.properties.mode.type, "string")
  assert.equal(once.properties.mode.enum, undefined)
  assert.match(once.properties.mode.description, /Known values include: "auto"/)

  // Heterogeneous string | object items must NOT be forced to type:"string".
  assert.equal(once.properties.order.items.type, undefined)
  assert.ok(Array.isArray(once.properties.order.items.anyOf))
  assert.deepEqual(once.properties.order.items.anyOf[1].properties.type, { type: "string", enum: ["divider"] })
  assert.match(once.properties.order.items.description, /Accepts anyOf: string \| \{ type: "divider" \}/)
  assert.doesNotMatch(JSON.stringify(once), /gemini/i)
  assert.deepEqual(twice, once)
})

test("a 40-variant union over 4 shared $defs expands fully and lifts to the root", () => {
  const $defs = {}
  for (let d = 0; d < 4; d++) {
    $defs[`D${d}`] = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${d}_${i}`, { type: "string" }])),
    }
  }
  const oneOf = Array.from({ length: 40 }, (_, v) => ({
    type: "object",
    properties: {
      kind: { const: `k${v}` },
      a: { $ref: "#/$defs/D0" },
      b: { $ref: "#/$defs/D1" },
      c: { $ref: "#/$defs/D2" },
      d: { $ref: "#/$defs/D3" },
    },
    required: ["kind"],
  }))
  const schema = fullPipeline({ type: "object", $defs, oneOf })
  const text = JSON.stringify(schema)
  assert.equal(schema.anyOf, undefined)
  assert.equal(schema.oneOf, undefined)
  assert.equal(schema.type, "object")
  assert.deepEqual(schema.required, ["kind"])
  assert.equal(schema.properties.kind.enum.length, 40)
  for (const [key, d] of [["a", 0], ["b", 1], ["c", 2], ["d", 3]]) {
    assert.equal(schema.properties[key].type, "object")
    assert.equal(Object.keys(schema.properties[key].properties).length, 15)
    assert.equal(schema.properties[key].properties[`f${d}_14`].type, "string")
  }
  assert.doesNotMatch(text, /Schema expansion limit|Recursive schema/)
  assert.ok(text.length < 20_000, String(text.length))
})

test("ordinary properties never use the expansion budget", () => {
  const properties = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`p${i}`, { type: "integer" }]))
  const schema = fullPipeline({ type: "object", properties })
  assert.equal(Object.keys(schema.properties).length, 2100)
  for (const value of Object.values(schema.properties)) assert.deepEqual(value, { type: "integer" })
})

test("shared $ref expansions are separate copies", () => {
  const schema = expandToolSchema({
    type: "object",
    $defs: { P: { type: "object", properties: { x: { type: "number" } } } },
    properties: { a: { $ref: "#/$defs/P" }, b: { $ref: "#/$defs/P" }, c: { $ref: "#/$defs/P" } },
  })
  assert.deepEqual(schema.properties.b, schema.properties.c)
  assert.notEqual(schema.properties.b, schema.properties.c)
  assert.notEqual(schema.properties.b.properties, schema.properties.c.properties)
  schema.properties.b.properties.x.type = "string"
  assert.equal(schema.properties.c.properties.x.type, "number")
})

test("recursive z.lazy trees keep the object type at the cycle and add no string type", () => {
  const schema = fullPipeline({
    type: "object",
    $defs: {
      Node: {
        type: "object",
        properties: {
          name: { type: "string" },
          children: { type: "array", items: { $ref: "#/$defs/Node" } },
        },
        required: ["name"],
      },
    },
    properties: { tree: { $ref: "#/$defs/Node" } },
  })
  const tree = schema.properties.tree
  assert.equal(tree.type, "object")
  assert.deepEqual(tree.required, ["name"])
  assert.equal(tree.properties.children.type, "array")
  assert.equal(tree.properties.children.items.type, "object")
  assert.match(tree.properties.children.items.description, /Recursive schema/)
  assert.doesNotMatch(JSON.stringify(schema), /"type":"string","description":"Recursive/)
})

test("closed prefixItems tuples keep their length and element types", () => {
  const schema = fullPipeline({
    type: "object",
    properties: {
      pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false },
      point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false, maxItems: 5 },
      empty: { type: "array", items: false },
    },
  })
  const { pair, point, empty } = schema.properties
  assert.equal(pair.maxItems, 2)
  assert.deepEqual(pair.items.anyOf, [{ type: "string" }, { type: "number" }])
  assert.equal(point.maxItems, 2)
  assert.deepEqual(point.items, { type: "number" })
  assert.equal(empty.maxItems, 0)
})

test("const literals: numeric and boolean unions keep their values, empty string and null get hints", () => {
  const schema = fullPipeline({
    type: "object",
    properties: {
      version: { anyOf: [{ type: "number", const: 1 }, { type: "number", const: 2 }] },
      flag: { anyOf: [{ const: true }, { const: false }] },
      empty: { const: "" },
      nothing: { const: null },
      seven: { const: 7 },
      ratio: { const: 0.5 },
      on: { const: true },
      shape: { const: { a: 1 } },
      list: { const: [1, 2] },
      nullableConst: { type: ["string", "null"], const: "x" },
      allNull: { anyOf: [{ type: "null" }, { const: null }] },
      maybe: { anyOf: [{ type: "string", enum: ["a", "b"] }, { const: null }] },
    },
  })
  const p = schema.properties
  assert.equal(p.version.type, "number")
  assert.match(p.version.description, /Allowed values: 1, 2/)
  assert.equal(p.flag.type, "boolean")
  assert.match(p.flag.description, /Allowed values: true, false/)
  assert.equal(p.empty.type, "string")
  assert.equal(p.empty.enum, undefined)
  assert.match(p.empty.description, /Must equal: ""/)
  assert.deepEqual(p.nothing, { description: "Must be null." })
  assert.equal(p.seven.type, "integer")
  assert.match(p.seven.description, /Must equal: 7/)
  assert.equal(p.ratio.type, "number")
  assert.equal(p.on.type, "boolean")
  assert.match(p.on.description, /Must equal: true/)
  assert.equal(p.shape.type, "object")
  assert.match(p.shape.description, /Must equal: \{"a":1\}/)
  assert.equal(p.list.type, "array")
  assert.match(p.list.description, /Must equal: \[1,2\]/)
  assert.deepEqual(p.nullableConst, { type: "string", enum: ["x"] })
  assert.deepEqual(p.allNull, { description: "Must be null." })
  assert.equal(p.maybe.type, "string")
  assert.deepEqual(p.maybe.enum, ["a", "b"])
  assert.match(p.maybe.description, /Nullable string/)
  // `list` is skipped: its permissive items (from ensureGeminiArrayItems) list a null leaf.
  const { list: _list, ...rest } = p
  assert.doesNotMatch(JSON.stringify(rest), /"type":\s*(\[[^\]]*"null"|"null")/)
})

test("variant hints keep per-variant descriptions and stay under a length cap", () => {
  const $defs = {}
  for (let d = 0; d < 3; d++) {
    $defs[`S${d}`] = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`long_field_${d}_${i}`, { type: "string" }])),
    }
  }
  const oneOf = Array.from({ length: 25 }, (_, v) => ({
    type: "object",
    description: `Perform   action ${v}\n with a long description that keeps going well past the snippet limit for sure`,
    properties: {
      action: { const: `act_${v}` },
      x: { $ref: "#/$defs/S0" },
      y: { $ref: "#/$defs/S1" },
      z: { $ref: "#/$defs/S2" },
    },
    required: ["action"],
  }))
  const schema = fullPipeline({ type: "object", $defs, oneOf })
  assert.ok(schema.description.length < 2500, String(schema.description.length))
  assert.match(schema.description, /^Variants: \{ action: "act_0", x\?: object/)
  assert.match(schema.description, /\(Perform action 0 with a long description/)
  assert.match(schema.description, /\| \.\.\. \(\+\d+ more\)$/)
  assert.equal(schema.properties.action.enum.length, 25)

  const two = fullPipeline({
    oneOf: [
      { type: "object", description: "Click at coordinates", properties: { method: { const: "click" } } },
      { type: "object", description: "Take a screenshot", properties: { method: { const: "screenshot" } } },
    ],
  })
  assert.match(two.description, /^Variants: \{ method\?: "click" \} \(Click at coordinates\) \| \{ method\?: "screenshot" \} \(Take a screenshot\)$/)
})

test("true and false property schemas carry hints without a fabricated type", () => {
  const schema = fullPipeline({
    type: "object",
    properties: {
      data: true,
      never: false,
      either: { anyOf: [true, { type: "string" }] },
    },
  })
  assert.deepEqual(schema.properties.data, { description: "Accepts any JSON value." })
  assert.deepEqual(schema.properties.never, { description: "No value is allowed by the original schema." })
  assert.equal(schema.properties.either.type, undefined)
  assert.match(schema.properties.either.description, /Accepts anyOf: any \| string/)
})

test("cross-variant property collisions stay an anyOf with a summary", () => {
  const schema = fullPipeline({
    oneOf: [
      { type: "object", properties: { value: { type: "string" }, ver: { const: 1 } } },
      { type: "object", properties: { value: { type: "number" }, ver: { const: 2 } } },
    ],
  })
  assert.equal(schema.properties.value.type, undefined)
  assert.deepEqual(schema.properties.value.anyOf, [{ type: "string" }, { type: "number" }])
  assert.match(schema.properties.value.description, /Accepts anyOf: string \| number/)
  assert.equal(schema.properties.ver.type, "integer")
  assert.match(schema.properties.ver.description, /Allowed values: 1, 2/)
})

test("$ref to a schema map or a non-schema value is unresolved", () => {
  const schema = fullPipeline({
    type: "object",
    $defs: { E: { type: "string", enum: ["a"] } },
    properties: {
      map: { $ref: "#/properties" },
      defs: { $ref: "#/$defs" },
      enumList: { $ref: "#/$defs/E/enum" },
      named: { $ref: "#/properties/properties" },
      properties: { type: "boolean" },
      real: { $ref: "#/$defs/E" },
    },
  })
  const p = schema.properties
  for (const key of ["map", "defs", "enumList"]) {
    assert.equal(p[key].type, undefined, key)
    assert.equal(p[key].properties, undefined, key)
    assert.match(p[key].description, /Unresolved schema reference/, key)
  }
  assert.deepEqual(p.named, { type: "boolean" })
  assert.deepEqual(p.real, { type: "string", enum: ["a"] })
})

test("allOf narrows number with integer and flags type and enum conflicts", () => {
  const schema = fullPipeline({
    type: "object",
    properties: {
      count: { allOf: [{ type: "number", minimum: 0 }, { type: "integer" }] },
      mixed: { allOf: [{ type: "string" }, { type: "number" }] },
      mode: { allOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] },
    },
  })
  assert.deepEqual(schema.properties.count, { type: "integer", minimum: 0 })
  assert.equal(schema.properties.mixed.type, "string")
  assert.match(schema.properties.mixed.description, /Conflicting type constraints in allOf: string vs number/)
  assert.equal(schema.properties.mode.enum, undefined)
  assert.match(schema.properties.mode.description, /Conflicting enum constraints in allOf/)
})

test("bridge request path delivers expanded schemas and default ToolSearch schema to MCP tools/list", async () => {
  const kit = await createBridgeKit()
  try {
    let listed = null
    kit.prompts.push(async (agent) => {
      listed = await agent.listTools()
      await agent.text("checked tools")
    })

    const res = await kit.request(baseBody({
      tools: [
        { name: "ToolSearch", description: "Deferred tool search" },
        {
          name: "cua_action",
          description: "Desktop GUI action",
          input_schema: {
            type: "object",
            $defs: {
              Point: {
                type: "object",
                additionalProperties: false,
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
              },
            },
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  method: { const: "move" },
                  params: { $ref: "#/$defs/Point" },
                },
                required: ["method", "params"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  method: { const: "capture" },
                  env: { type: "object", additionalProperties: { type: "string" } },
                },
                required: ["method"],
              },
            ],
          },
        },
      ],
    }))
    const parsed = await readSse(res)
    assert.equal(parsed.stopReason, "end_turn")

    const mcpTools = listed?.result?.tools ?? []
    const searchTool = mcpTools.find((t) => t.name === "ToolSearch")
    const cuaTool = mcpTools.find((t) => t.name === "cua_action")

    assert.ok(searchTool, "ToolSearch must be exposed over MCP tools/list")
    assert.deepEqual(searchTool.inputSchema.required, TOOL_SEARCH_INPUT_SCHEMA.required)
    assert.equal(searchTool.inputSchema.properties?.query?.type, "string")
    assert.equal(searchTool.inputSchema.properties?.max_results?.type, "integer")

    assert.ok(cuaTool, "cua_action must be exposed over MCP tools/list")
    assert.equal(cuaTool.inputSchema.$defs, undefined)
    assert.equal(cuaTool.inputSchema.oneOf, undefined)
    assert.equal(cuaTool.inputSchema.additionalProperties, false)
    assert.deepEqual(cuaTool.inputSchema.required, ["method"])
    assert.deepEqual(cuaTool.inputSchema.properties?.method, { type: "string", enum: ["move", "capture"] })
    assert.deepEqual(cuaTool.inputSchema.properties?.params?.required, ["x", "y"])
    assert.equal(cuaTool.inputSchema.properties?.params?.additionalProperties, false)
    assert.match(cuaTool.inputSchema.properties?.env?.description ?? "", /Additional properties: string/)
  } finally {
    await kit.dispose()
  }
})
