import assert from "node:assert/strict"
import test from "node:test"
import { MIN_TEXT, TOOL_TOKEN_BUDGET, agyTokens, cut, fitTools } from "../tool-budget.mjs"

const total = (tools) => tools.reduce((n, t) => n + agyTokens(JSON.stringify(t)), 0)

// a schema with its prose taken out, so two shapes compare by what the model
// may send
function structure(node) {
  if (Array.isArray(node)) return node.map(structure)
  if (!node || typeof node !== "object") return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === "description") continue
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, structure(s)])) : structure(v)
  }
  return out
}
const undecorated = (node) => {
  if (Array.isArray(node)) return node.map(undecorated)
  if (!node || typeof node !== "object") return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (["$schema", "title", "examples"].includes(k)) continue
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, undecorated(s)])) : undecorated(v)
  }
  return out
}

const long = (what, n) => `${what} does the thing it says. `.repeat(n) + "Examples: " + `${what}("a"), ${what}("b"). `.repeat(n)

// a client's catalog about plugins#1140's size: 80 tools, each with a
// long description, long property texts, an enum, a property named "title"
// and one contract property whose text is all there is to it
function catalog(n = 80, size = 2) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: long(`tool_${i}`, size),
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      title: `Tool ${i}`,
      properties: {
        title: { type: "string", description: long("title", size), examples: ["x"] },
        mode: { type: "string", enum: ["a", "b"], description: "Short." },
        style: { type: "object", description: "Variants: " + long("style", size) },
        list: { type: "array", items: { type: "string", description: long("item", size) } },
      },
      required: ["title"],
    },
    _meta: { "antigravity/alwaysLoad": true },
  }))
}

test("a catalog within the budget goes as it is", () => {
  const tools = catalog(10, 1)
  assert.ok(total(tools) <= TOOL_TOKEN_BUDGET)
  assert.equal(fitTools(tools), tools)
})

test("a catalog over the budget keeps every tool and its whole schema, and fits", () => {
  const tools = catalog()
  // about plugins#1140's 131 tools (~76 KB, ~25,000 agy tokens)
  assert.ok(total(tools) > 20000 && total(tools) < 30000, `the fixture is over agy's budget (${total(tools)})`)
  const fitted = fitTools(tools)
  assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
  assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
  for (let i = 0; i < tools.length; i++) {
    // nothing that decides a valid argument changes: names, types, enum,
    // required, items; a property named "title" is the client's and stays
    assert.deepEqual(structure(fitted[i].inputSchema), structure(undecorated(tools[i].inputSchema)))
    assert.ok(fitted[i].inputSchema.properties.title, "the property named title stays")
    assert.equal(fitted[i].inputSchema.$schema, undefined)
    assert.equal(fitted[i].inputSchema.title, undefined)
    assert.deepEqual(fitted[i]._meta, tools[i]._meta)
    const p = fitted[i].inputSchema.properties
    // a short description is left whole; long ones are cut, a contract's least
    assert.equal(p.mode.description, "Short.")
    assert.ok(p.title.description.length < tools[i].inputSchema.properties.title.description.length)
    assert.ok(p.style.description.length > p.title.description.length, "a contract keeps more")
    assert.ok(fitted[i].description.length >= p.title.description.length, "a tool's own keeps more")
  }
  // the client's catalog itself is untouched
  assert.equal(tools[0].inputSchema.title, "Tool 0")
})

test("a catalog too large for any description keeps every tool", () => {
  const tools = catalog(400, 6)
  const fitted = fitTools(tools)
  assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
  for (const t of fitted) assert.equal(t.inputSchema.properties.title.description, undefined)
})

// plugins#1140's 131 tools after 0.1.46: the schemas alone took ~37 KB of
// the budget, the level stopped at 10, and 373 of 382 property texts went
// as 9-byte stubs ("The fil…") that spent ~10 KB on their keys
function heavy(n, props = 3) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: long(`tool_${i}`, 3),
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(Array.from({ length: props }, (_, j) => [`field_${j}`, { type: "string", description: long(`field_${j}`, 2) }])),
        view: { type: "object", description: long("view", 4) },
        flag: { type: "boolean", description: "Short." },
      },
    },
  }))
}
const bytes = (s) => new TextEncoder().encode(s).length

for (const n of [131, 180]) {
  test(`with ${n} heavy tools, no property text is a stub and the room goes to the tools' own (plugins#1140)`, () => {
    const tools = heavy(n)
    const fitted = fitTools(tools)
    assert.ok(total(fitted) <= TOOL_TOKEN_BUDGET, `fits (${total(fitted)})`)
    assert.deepEqual(fitted.map((t) => t.name), tools.map((t) => t.name))
    for (let i = 0; i < tools.length; i++) {
      assert.deepEqual(structure(fitted[i].inputSchema), structure(tools[i].inputSchema))
      const p = fitted[i].inputSchema.properties
      for (const [k, v] of Object.entries(p)) {
        const was = tools[i].inputSchema.properties[k].description
        if (v.description !== undefined && v.description !== was) assert.ok(bytes(v.description) >= MIN_TEXT, `${k}: ${v.description}`)
      }
      assert.equal(p.flag.description, "Short.", "a text that fits whole stays")
      const own = fitted[i].description
      if (own !== undefined) assert.ok(bytes(own) >= MIN_TEXT, `the tool's own: ${own}`)
      if (n === 131) assert.ok(own, "with room, every tool says what it is for")
      assert.ok(bytes(p.view.description ?? "") >= MIN_TEXT, `the contract keeps its text: ${p.view.description}`)
    }
  })
}

test("cut stops on a whole character, within the bytes, and drops the examples first", () => {
  const zh = "这是一个很长的中文说明，每个字是三个字节。".repeat(10)
  for (const max of [10, 11, 12, 40, 100]) {
    const out = cut(zh, max)
    assert.ok(new TextEncoder().encode(out).length <= max, `${max}: ${out}`)
    assert.ok(!out.includes("�"))
    assert.ok(out.endsWith("…"))
  }
  assert.equal(cut("Reads a file. Examples: read('a'), read('b')", 20), "Reads a file.")
  assert.equal(cut("short", 100), "short")
  assert.equal(cut("anything longer", 3), null)
})
