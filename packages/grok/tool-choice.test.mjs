import { noRealGrok } from "./nocli.mjs"
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

noRealGrok()

// magpie hands a request that turned tools off with none declared
// "tool_choice": "none" (yetone/magpie#3110); Grok refuses a tool_choice
// with no tools beside it, so it goes before the request does.
test("a tool_choice with no tools beside it is left out", () => {
  for (const q of [
    { model: "grok-4.7", tool_choice: "none", input: [] },
    { model: "grok-4.7", tools: [], tool_choice: "none", input: [] },
    { model: "grok-4.7", tool_choice: "auto", input: [] },
    { model: "grok-4.7", tools: [{ type: "custom", name: "apply_patch" }], tool_choice: "none", input: [] },
  ]) {
    const sent = JSON.parse(_internal.rewrite(JSON.stringify(q)))
    expect(Object.hasOwn(sent, "tool_choice")).toBe(false)
    expect(sent.model).toBe("grok-4.7")
  }
})

test("a tool_choice with tools stays", () => {
  const body = JSON.stringify({ tools: [{ type: "function", name: "x", parameters: { type: "object" } }], tool_choice: "none", input: [] })
  expect(_internal.rewrite(body)).toBe(body)
})
