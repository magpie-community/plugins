import { noRealGrok } from "./nocli.mjs"
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

noRealGrok()

// #524: Grok answers 400 'Argument not supported: "output.encrypted_content"
// in "include" field'. Codex asks for it beside reasoning.encrypted_content
// when output token replay is on (codex-rs/core/src/client.rs).
const send = (body, search = false) => JSON.parse(_internal.rewrite(JSON.stringify(body), search))

test("an include-only body loses output.encrypted_content (reporter's case 1)", () => {
  expect(send({ model: "grok-4.7", include: ["output.encrypted_content"] })).toEqual({ model: "grok-4.7" })
})

test("a body with tools loses it too (reporter's case 2)", () => {
  expect(send({ model: "grok-4.7", tools: [], include: ["output.encrypted_content"] })).toEqual({ model: "grok-4.7", tools: [] })
})

for (const search of [false, true]) {
  test(`Codex's include keeps reasoning.encrypted_content (x_search ${search})`, () => {
    const sent = send({
      model: "grok-4.7", input: "hi", store: false, stream: true, reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content", "output.encrypted_content"],
    }, search)
    expect(sent.include).toEqual(["reasoning.encrypted_content"])
    expect(sent.store).toBe(false)
  })
}

test("values Grok takes are left as sent", () => {
  const body = JSON.stringify({ model: "grok-4.7", input: "hi", include: ["reasoning.encrypted_content", "web_search_call.action.sources"] })
  expect(_internal.rewrite(body)).toBe(body)
})
