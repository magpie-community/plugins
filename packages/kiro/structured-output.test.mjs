// A request's structured output reaches Kiro in words. Kiro's
// generateAssistantResponse has no field for the answer's format, so
// magpie's built-in told the model the schema in the system prompt
// (internal/gateway/kiro.go: req.inSystem(), format.go's instruction). The
// plugin dropped output_config.format, so a caller asking for JSON got
// prose back.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro } = _internal
const first = (r, budget = 0) => {
  const s = JSON.parse(buildKiro(r, "claude-sonnet-4.5", "", budget)).conversationState
  return (s.history?.[0] ?? s.currentMessage).userInputMessage.content
}
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }
const told = 'Respond with a single JSON value and nothing else, matching this JSON schema:\n{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}.'

test("output_config.format's schema is told at the end of the system prompt, as the built-in told it", () => {
  const req = { system: "Be brief.", messages: [{ role: "user", content: "hi" }], output_config: { format: { type: "json_schema", schema } } }
  expect(first(req)).toBe("Be brief.\n\n" + told + "\n\nhi")
})

test("with no system prompt the schema is the whole of it, after a thinking budget", () => {
  const req = { messages: [{ role: "user", content: "hi" }], output_config: { effort: "high", format: { type: "json_schema", schema } } }
  expect(first(req)).toBe(told + "\n\nhi")
  expect(first(req, 30000)).toBe("<thinking_mode>enabled</thinking_mode><max_thinking_length>30000</max_thinking_length>\n" + told + "\n\nhi")
})

test("the AI SDK's output_format is told too", () => {
  const req = { system: [{ type: "text", text: "Be brief." }], messages: [{ role: "user", content: "hi" }], output_format: { type: "json_schema", schema } }
  expect(first(req)).toBe("Be brief.\n\n" + told + "\n\nhi")
})

test("a request with no format, or one with no schema, is sent as before", () => {
  for (const extra of [{}, { output_config: { effort: "low" } }, { output_config: { format: { type: "json_schema" } } }, { output_config: { format: { type: "text" } } }]) {
    const req = { system: "Be brief.", messages: [{ role: "user", content: "hi" }], ...extra }
    expect(first(req)).toBe("Be brief.\n\nhi")
  }
})
