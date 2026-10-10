import assert from "node:assert/strict"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

// Override only for the review's old/new comparison. These tests never fetch
// or read a user's Comate settings, regardless of which entry is imported.
const entry = process.env.COMATE_REGRESSION_ENTRY
  ? pathToFileURL(process.env.COMATE_REGRESSION_ENTRY).href
  : new URL("./index.mjs", import.meta.url).href
const { _internal } = await import(entry)

const history = {
  model: "fixture",
  messages: [
    { role: "system", content: "Answer using the supplied tool result." },
    { role: "user", content: "What is my bridge value?" },
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_bridge_1", type: "function", function: { name: "read_bridge_value", arguments: '{"key":"acceptance"}' } }],
    },
    { role: "tool", tool_call_id: "call_bridge_1", content: "COMATE_RESULT_7319" },
  ],
  tools: [{ type: "function", function: { name: "read_bridge_value", description: "Return a bridge value.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } }],
}

test("a continued turn carries the client's tool result", () => {
  assert.ok(_internal.queryOf(history).includes("COMATE_RESULT_7319"), "the Comate query lost the tool result")
})

test("a continued turn carries the assistant's call and correlation ID", () => {
  const query = _internal.queryOf(history)
  assert.ok(query.includes("call_bridge_1"), "the Comate query lost the tool-call correlation ID")
  assert.ok(query.includes("read_bridge_value"), "the Comate query lost the called function")
})

test("a tool request tells the text backend which function schema to use", () => {
  const query = _internal.queryOf({ ...history, messages: history.messages.slice(0, 2) })
  assert.ok(query.includes("read_bridge_value") && query.includes('"required"'), "the Comate query lost the offered tool schema")
})
