// Devin answers "Unable to process request due to an MCP configuration
// issue" (permission_denied) to a request whose tool schemas carry some
// agents' own words in their parameters' descriptions, whatever the tool is
// named: Cursor's Read, Grep, Glob, WebSearch, ReadLints and EditNotebook
// each failed alone, and passed with the same schema and no descriptions in
// it. Each parameter's words go to the tool's entry in <tool_descriptions>
// instead, where the model still reads them, and the schema keeps its shape.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

// sent is each tool sent with the request: name -> its schema, parsed.
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

// text is every prompt's text, joined.
const text = (b) =>
  _internal
    .fields(b)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const t = _internal.fields(f.data).find((g) => g.num === 3)
      return t ? dec.decode(t.data) : ""
    })
    .join("\n")

// Cursor's Read, as Cursor BYOK offers it: alone it was refused
const READ = {
  type: "object",
  properties: {
    limit: { description: "The number of lines to read. Only provide if the file is too large to read at once.", type: "integer" },
    offset: {
      description:
        "The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once.",
      type: "integer",
    },
    path: { description: "The absolute path of the file to read.", type: "string" },
  },
  required: ["path"],
}

const hasDescription = (s) => JSON.stringify(s).includes('"description":"')

test("a chat tool's schema goes to Devin without its parameters' descriptions, which go with the tool's own", () => {
  const before = JSON.stringify(READ)
  const chat = {
    messages: [{ role: "user", content: "ok" }],
    tools: [{ type: "function", function: { name: "Read", description: "Reads a file.", parameters: READ } }],
  }
  const b = _internal.build(chat, "swe-2-1-high", "k")
  const got = sent(b).Read
  expect(hasDescription(got)).toBe(false)
  expect(got).toEqual({
    type: "object",
    properties: { limit: { type: "integer" }, offset: { type: "integer" }, path: { type: "string" } },
    required: ["path"],
  })
  const said = text(b)
  expect(said).toContain('<tool name="Read">\nReads a file.\n\nParameters:\n')
  expect(said).toContain("- path: The absolute path of the file to read.")
  expect(said).toContain("- offset: The line number to start reading from.")
  // the caller's own schema is left as it came
  expect(JSON.stringify(READ)).toBe(before)
})

test("a Messages tool's schema goes to Devin without its parameters' descriptions", () => {
  const req = {
    max_tokens: 32,
    messages: [{ role: "user", content: "ok" }],
    tools: [{ name: "Read", description: "Reads a file.", input_schema: READ }],
  }
  const b = _internal.buildMessages(req, "claude-opus-5-5-high", "k")
  expect(hasDescription(sent(b).Read)).toBe(false)
  expect(text(b)).toContain("- path: The absolute path of the file to read.")
})

test("a tool with no description of its own still has its parameters described", () => {
  const chat = {
    messages: [{ role: "user", content: "ok" }],
    tools: [{ type: "function", function: { name: "Read", parameters: READ } }],
  }
  const said = text(_internal.build(chat, "swe-2-1-high", "k"))
  expect(said).toContain('<tool name="Read">\nParameters:\n- limit: The number of lines to read.')
})

test("nested and listed parameters are named by their path; a parameter named description and data values stay", () => {
  const { describedTool } = _internal
  const schema = {
    type: "object",
    description: "What to do.",
    properties: {
      description: { type: "string", description: "A short label." },
      todos: {
        type: "array",
        description: "The list.",
        items: {
          type: "object",
          properties: { status: { type: "string", enum: ["a", "b"], description: "Its state.\nOne of two." } },
          default: { description: "data, not a schema" },
        },
      },
      when: { anyOf: [{ type: "string", description: "A date." }, { type: "null" }] },
    },
  }
  const got = describedTool({ name: "t", description: "", schema })
  expect(got.schema).toEqual({
    type: "object",
    properties: {
      description: { type: "string" },
      todos: {
        type: "array",
        items: { type: "object", properties: { status: { type: "string", enum: ["a", "b"] } }, default: { description: "data, not a schema" } },
      },
      when: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  })
  expect(got.description).toBe(
    "Parameters:\nWhat to do.\n- description: A short label.\n- todos: The list.\n- todos[].status: Its state.\n  One of two.\n- when: A date.",
  )
})

test("a tool whose schema has no descriptions is sent as it came", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }
  const t = { name: "t", description: "d", schema }
  expect(_internal.describedTool(t)).toBe(t)
})

test("Devin's MCP configuration refusal is a 400: the same request is refused again", () => {
  const got = _internal.failure(
    200,
    JSON.stringify({ code: "permission_denied", message: "Unable to process request due to an MCP configuration issue. (trace ID: x)" }),
  )
  expect(got.status).toBe(400)
  expect(got.message).toContain("MCP configuration issue")
})
