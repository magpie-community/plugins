// Roing (plugins#1604): Command Code turned a request away whole when one
// of its tools had REA's path guard, ^[^\uD800-\uDFFF]*$: 400 "Invalid
// schema for function "mcp__rea__close_binary": a surrogate-range regex is
// not a valid regex". A pattern that names a surrogate is left out of the
// tools sent, on the Provider API and on Go's /alpha/generate, for every
// model; every other keyword, allOf, anyOf and $schema among them, and
// every other pattern go as they came, and so does a property named
// pattern.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
})

// REA's path, as plugins#1080 has it: the guard inside an allOf, beside a
// NUL guard and an absolute-path one
const GUARD = "^[^\\uD800-\\uDFFF]*$"
const PATH = {
  type: "string",
  minLength: 1,
  allOf: [{ pattern: "^[^\\x00]*$" }, { pattern: GUARD }, { pattern: "^(?:[\\x5C\\x2F]|[A-Za-z]:[\\x5C\\x2F])" }],
}
const REA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    path: PATH,
    paths: { type: "array", items: { type: "string", pattern: GUARD } },
    mode: { anyOf: [{ type: "string", enum: ["ro", "rw"] }, { type: "null" }] },
    ref: { $ref: "#/$defs/path" },
  },
  required: ["path"],
  $defs: { path: PATH },
  additionalProperties: false,
}
const REA_SENT = {
  ...REA,
  properties: {
    ...REA.properties,
    path: { ...PATH, allOf: [PATH.allOf[0], {}, PATH.allOf[2]] },
    paths: { type: "array", items: { type: "string" } },
  },
  $defs: { path: { ...PATH, allOf: [PATH.allOf[0], {}, PATH.allOf[2]] } },
}
// Claude Code's Grep: a property named pattern, required, with a pattern
// of its own that names no surrogate
const GREP = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    pattern: { type: "string", description: "The regular expression pattern to search for" },
    path: { type: "string" },
    glob: { type: "string", pattern: "^[^\\0]*$" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
  },
  required: ["pattern"],
  additionalProperties: false,
}
const tool = (name, parameters) => ({ type: "function", function: { name, description: "d", parameters } })

test("a pattern naming a surrogate is left out at any depth, the rest as it came, the caller's untouched", () => {
  const before = structuredClone(REA)
  expect(_internal.noSurrogatePatterns(REA)).toEqual(REA_SENT)
  expect(REA).toEqual(before)
  expect(_internal.noSurrogatePatterns(GREP)).toBe(GREP)
})

test("each way of naming a surrogate is seen, and nothing else is", () => {
  const p = (pattern) => _internal.noSurrogatePatterns({ type: "string", pattern })
  for (const pattern of [GUARD, "^[^\\u0000\\uD800-\\uDFFF]*$", "[\\ud83d][\\ude00-\\ude4f]", "^[^\\u{D800}-\\u{DFFF}]*$", "\\x{DBFF}", "a\uD800b"])
    expect(p(pattern)).toEqual({ type: "string" })
  for (const pattern of ["^[a-z]+$", "^[^\\\\uD800]*$", "^[\\uE000-\\uF8FF]+$", "\\u{1F600}", "^😀+$", "\\uD7FF", "^[^\\0]*$"])
    expect(p(pattern)).toEqual({ type: "string", pattern })
  // data that happens to hold such a string is not a pattern
  const data = { type: "object", properties: { x: { type: "string", enum: [GUARD], default: GUARD, examples: [{ pattern: GUARD }] } } }
  expect(_internal.noSurrogatePatterns(data)).toBe(data)
})

// sends tools for model through a plan's fetch and gives the request body
// the gateway was sent, as text, with the tools' schemas
async function sent(plan, model, tools) {
  const out = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname
    if (path.endsWith("/chat/completions")) {
      const b = init.body ?? (input instanceof Request ? await input.text() : undefined)
      out.push({ raw: b, schemas: JSON.parse(b).tools.map((t) => t.function.parameters) })
      return Response.json({ choices: [] })
    }
    if (path === "/alpha/generate") {
      out.push({ raw: init.body, schemas: JSON.parse(init.body).params.tools.map((t) => t.input_schema) })
      return new Response(JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } }) + "\n")
    }
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: plan.toLowerCase(), metadata: { plan } }))
  const raw = JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }], tools })
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: raw })
  await res.text()
  expect(out.length).toBe(1)
  return { ...out[0], same: out[0].raw === raw }
}

for (const plan of ["GOAT", "Go"])
  test(`${plan}: REA's guard is left out for every model, Grep's pattern property kept`, async () => {
    for (const m of ["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-4-6", "google/gemini-3.8-flash", "reflection/beam:free"]) {
      const before = structuredClone(REA)
      const { schemas } = await sent(plan, m, [tool("mcp__rea__close_binary", REA), tool("Grep", GREP)])
      const rea = m.startsWith("google/") ? _internal.googleSchema(REA_SENT) : REA_SENT
      expect(schemas).toEqual([rea, GREP])
      expect(REA).toEqual(before)
    }
  })

test("GOAT: tools with no such pattern leave the request's bytes as they came", async () => {
  const { same, schemas } = await sent("GOAT", "deepseek/deepseek-v4-pro", [tool("Grep", GREP)])
  expect(schemas).toEqual([GREP])
  expect(same).toBe(true)
})
