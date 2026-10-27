// A chat's structured output reaches Devin in words. Devin's
// GetChatMessage has no field for the answer's format, so magpie's built-in
// told the model in the instructions (internal/gateway/devin.go:
// req.inSystem(), format.go's instruction). The plugin dropped
// response_format, so a caller asking for JSON got prose back.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

// sent is each message's role and text as build() gives them to Devin.
const sent = (chat) =>
  _internal
    .fields(_internal.build(chat, "swe-2-high", "k"))
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const m = { role: 0, text: "" }
      for (const g of _internal.fields(f.data)) {
        if (g.num === 2) m.role = g.n
        else if (g.num === 3) m.text = dec.decode(g.data)
      }
      return m
    })

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
const told = 'Respond with a single JSON value and nothing else, matching this JSON schema:\n{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}.'
const object = "Respond with a single JSON object and nothing else."
const chat = (response_format) => ({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], response_format })

test("response_format's json_schema is told at the end of the instructions, as the built-in told it", () => {
  expect(sent(chat({ type: "json_schema", json_schema: { name: "r", schema, strict: true } }))[0].text).toBe("Be brief.\n\n" + told + "\n\nhi")
})

test("json_object, or a json_schema with no schema, asks for any JSON object", () => {
  expect(sent(chat({ type: "json_object" }))[0].text).toBe("Be brief.\n\n" + object + "\n\nhi")
  expect(sent(chat({ type: "json_schema", json_schema: { name: "r" } }))[0].text).toBe("Be brief.\n\n" + object + "\n\nhi")
})

test("with no system message the format is the whole of the instructions", () => {
  expect(sent({ messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } })[0].text).toBe(object + "\n\nhi")
})

test("text, or no response_format, is sent as before", () => {
  expect(sent(chat({ type: "text" }))[0].text).toBe("Be brief.\n\nhi")
  expect(sent(chat(undefined))[0].text).toBe("Be brief.\n\nhi")
})

// magpie says a failed tool's result as "Error: …", as the built-in did
// (devin.go: IsError); it goes to Devin as it came
test("a failed tool's result goes to Devin as magpie worded it", () => {
  const got = sent({
    messages: [
      { role: "user", content: "run it" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_a", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_a", content: "Error: exit status 1" },
    ],
  })
  expect(got.find((m) => m.role === 4).text).toBe("Error: exit status 1")
})
