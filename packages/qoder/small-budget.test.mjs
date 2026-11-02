// A request whose own max_tokens is small asks for no thinking: the default
// effort would spend its whole output budget on reasoning, as WorkBuddy's
// did on a 64-token title (plugins#643, itspig). Qoder's qoderBody had the
// same default, so it gets the same rule.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { qoderBody, modelInfo } = _internal
const tc = (disabled) => ({ enabled: { efforts: { low: {}, medium: {}, high: { is_default: true } } }, ...(disabled ? { disabled: {} } : {}) })
const optional = modelInfo({ key: "think-opt", is_reasoning: true, thinking_config: tc(true) })
const always = modelInfo({ key: "think-always", is_reasoning: true, thinking_config: tc(false) })
const chat = (extra) => ({ messages: [{ role: "user", content: "Title this chat." }], ...extra })
const params = (m, extra) => qoderBody(chat(extra), m).parameters

test("a small max_tokens with no effort asked does not think at the default", () => {
  for (const extra of [{ max_tokens: 64 }, { max_tokens: 1024 }, { max_completion_tokens: 64 }]) {
    expect(params(optional, extra).enable_thinking).toBe(false)
    expect(params(optional, extra).reasoning_effort).toBeUndefined()
    // A model that always thinks thinks at its lowest, as a request for none does.
    expect(params(always, extra)).toMatchObject({ enable_thinking: true, reasoning_effort: "low" })
  }
  expect(params(optional, { max_tokens: 64 }).max_tokens).toBe(64)
})

test("an asked effort, a larger budget or none named keeps what it had", () => {
  expect(params(optional, { max_tokens: 64, reasoning_effort: "high" })).toMatchObject({ enable_thinking: true, reasoning_effort: "high" })
  for (const extra of [{ max_tokens: 1025 }, { max_completion_tokens: 32000 }, {}]) {
    expect(params(optional, extra)).toMatchObject({ enable_thinking: true, reasoning_effort: "high" })
  }
})
